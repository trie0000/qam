# =============================================================================
# qam-server.ps1 — ローカル HTTP サーバ（HttpListener / 127.0.0.1）
# =============================================================================
# ブラウザ UI を配信し、現況/履歴/コメント/取込/設定の API を提供する。
# 127.0.0.1 で listen するので管理者権限不要（http://+ / http://* は使わない）。
# 設定は引数 > プロセス環境変数 > qam.env の順で解決。秘密情報は env のみ。
#   実行: pwsh server/qam-server.ps1   （通常は qam-start.bat から起動）
# =============================================================================
[CmdletBinding()]
param(
    [int]$Port,
    [string]$DataDir,
    [string]$WebDir,
    [string]$EnvFile,
    [int]$RetentionDays,
    [double]$GuardRatio
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot/qam-store.ps1"
. "$PSScriptRoot/qam-ingest.ps1"
. "$PSScriptRoot/qam-diff.ps1"
. "$PSScriptRoot/qam-pipeline.ps1"

# ─── env 読込・保存（KEY=VALUE、引数/既存 env を上書きしない） ───────────────
function Import-QamEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('='); if ($eq -lt 1) { continue }
        $k = $line.Substring(0, $eq).Trim(); $v = $line.Substring($eq + 1).Trim()
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        if (-not [Environment]::GetEnvironmentVariable($k)) { [Environment]::SetEnvironmentVariable($k, $v) }
    }
}
function Set-QamEnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = @(); if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*#?\s*$([regex]::Escape($Key))\s*=") { $lines[$i] = "$Key=$Value"; $found = $true; break }
    }
    if (-not $found) { $lines += "$Key=$Value" }
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot 'qam.env' }
Import-QamEnv $EnvFile
if (-not $DataDir) { $DataDir = $env:QAM_DATA_DIR }
if (-not $DataDir) { Write-Host '[qam] QAM_DATA_DIR が未設定です。qam.env を設定してください。' -ForegroundColor Red; exit 2 }
if (-not $Port) { $Port = if ($env:QAM_RELAY_PORT) { [int]$env:QAM_RELAY_PORT } else { 18090 } }
if (-not $RetentionDays) { $RetentionDays = if ($env:QAM_RAW_RETENTION_DAYS) { [int]$env:QAM_RAW_RETENTION_DAYS } else { 90 } }
if (-not $GuardRatio) { $GuardRatio = if ($env:QAM_SHRINK_GUARD_RATIO) { [double]$env:QAM_SHRINK_GUARD_RATIO } else { 0.5 } }
if (-not $WebDir) { $WebDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'web' }

$script:Cfg = [ordered]@{ dataDir = $DataDir; port = $Port; retentionDays = $RetentionDays; guardRatio = $GuardRatio }
$script:QamStop = $false
$staging = Join-Path $DataDir '.staging'
Initialize-QamStore $DataDir | Out-Null
if (-not (Test-Path -LiteralPath $staging)) { New-Item -ItemType Directory -Path $staging -Force | Out-Null }

# ─── HTTP ヘルパ ─────────────────────────────────────────────────────────────
$script:ContentTypes = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8' }

function Set-QamCors { param($Resp)
    $Resp.Headers['Access-Control-Allow-Origin'] = '*'
    $Resp.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $Resp.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
}
function Send-QamBytes { param($Ctx, [byte[]]$Bytes, [string]$Type, [int]$Status = 200)
    $r = $Ctx.Response; Set-QamCors $r; $r.StatusCode = $Status; $r.ContentType = $Type
    $r.ContentLength64 = $Bytes.Length; $r.OutputStream.Write($Bytes, 0, $Bytes.Length); $r.OutputStream.Close()
}
function Send-QamJson { param($Ctx, $Obj, [int]$Status = 200)
    Send-QamBytes $Ctx ([System.Text.Encoding]::UTF8.GetBytes(($Obj | ConvertTo-Json -Depth 12))) 'application/json; charset=utf-8' $Status
}
function Send-QamFile { param($Ctx, [string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { Send-QamJson $Ctx @{ error = 'not found' } 404; return }
    $ext = [System.IO.Path]::GetExtension($Path)
    $type = if ($script:ContentTypes.ContainsKey($ext)) { $script:ContentTypes[$ext] } else { 'application/octet-stream' }
    Send-QamBytes $Ctx ([System.IO.File]::ReadAllBytes($Path)) $type
}
function Get-QamBody { param($Req)
    if (-not $Req.HasEntityBody) { return '' }
    $sr = New-Object System.IO.StreamReader($Req.InputStream, $Req.ContentEncoding)
    try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}
# 現況スナップショットの records(hashtable) を name 昇順の配列へ。
function ConvertTo-QamRecordArray { param($Records)
    if (-not $Records) { return @() }
    @($Records.Values | Sort-Object { "$($_.name)" })
}

# ─── ルーティング ────────────────────────────────────────────────────────────
function Invoke-QamRoute {
    param($Ctx)
    $req = $Ctx.Request
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod
    Write-Host ("[qam] {0} {1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $method, $path) -ForegroundColor DarkGray
    if ($method -eq 'OPTIONS') { Send-QamBytes $Ctx ([byte[]]@()) 'text/plain' 204; return }
    $q = $req.QueryString

    switch -Regex ($path) {
        '^/qam/health$'   { Send-QamJson $Ctx @{ ok = $true; version = '0.1.0-phase1' }; return }
        '^/(qam/index\.html)?$' { Send-QamFile $Ctx (Join-Path $WebDir 'index.html'); return }
        '^/qam/app\.js$'  { Send-QamFile $Ctx (Join-Path $WebDir 'app.js'); return }
        '^/qam/app\.css$' { Send-QamFile $Ctx (Join-Path $WebDir 'app.css'); return }
        '^/qam/icons\.js$' { Send-QamFile $Ctx (Join-Path $WebDir 'icons.js'); return }

        '^/qam/dates$' {
            Send-QamJson $Ctx @{ dates = @(Get-QamSnapshotDates -DataDir $DataDir -Entity $q['entity']) }; return
        }
        '^/qam/current$' {
            $entity = $q['entity']; $asof = $q['asof']
            $date = Resolve-QamAsofDate -DataDir $DataDir -Entity $entity -Asof $asof
            if (-not $date) { Send-QamJson $Ctx @{ entity = $entity; asof = $asof; date = $null; outOfRange = $true; records = @() }; return }
            $snap = Read-QamSnapshot -DataDir $DataDir -Entity $entity -Date $date
            Send-QamJson $Ctx @{ entity = $entity; asof = $asof; date = $date; outOfRange = $false; records = (ConvertTo-QamRecordArray $snap.records) }; return
        }
        '^/qam/history$' {
            Send-QamJson $Ctx @{ events = @(Read-QamHistory -DataDir $DataDir -Entity $q['entity'] -From $q['from'] -To $q['to']) }; return
        }
        '^/qam/comments$' {
            Send-QamJson $Ctx @{ comments = @(Read-QamComments -DataDir $DataDir -Entity $q['entity'] -Id $q['id']) }; return
        }
        '^/qam/comment$' {
            if ($method -ne 'POST') { Send-QamJson $Ctx @{ error = 'POST only' } 405; return }
            $b = Get-QamBody $req | ConvertFrom-Json
            Add-QamComment -DataDir $DataDir -Entity $b.entity -Id $b.id -Author $b.author -Text $b.text -Ts ((Get-Date).ToUniversalTime().ToString('s') + 'Z')
            Send-QamJson $Ctx @{ ok = $true }; return
        }
        '^/qam/ingest/confirm$' {
            $b = Get-QamBody $req | ConvertFrom-Json
            $f = Join-Path $staging "$($b.token).xml"
            if (-not (Test-Path -LiteralPath $f)) { Send-QamJson $Ctx @{ error = 'staged file not found' } 404; return }
            $r = Invoke-QamIngest -DataDir $DataDir -XmlPath $f -GuardRatio $script:Cfg.guardRatio -RetentionDays $script:Cfg.retentionDays -Force
            Remove-Item -LiteralPath $f -Force
            Send-QamJson $Ctx $r; return
        }
        '^/qam/ingest$' {
            if ($method -ne 'POST') { Send-QamJson $Ctx @{ error = 'POST only' } 405; return }
            $tmp = Join-Path $staging ("upload-" + [guid]::NewGuid().ToString('N') + '.xml')
            Set-Content -LiteralPath $tmp -Value (Get-QamBody $req) -Encoding UTF8
            try {
                $r = Invoke-QamIngest -DataDir $DataDir -XmlPath $tmp -Entity $q['entity'] -Date $q['date'] -GuardRatio $script:Cfg.guardRatio -RetentionDays $script:Cfg.retentionDays
            } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; Send-QamJson $Ctx @{ error = $_.Exception.Message } 400; return }
            if ($r.guard -and -not $r.committed) {
                $token = "$($r.entity)__$($r.date)"
                Move-Item -LiteralPath $tmp -Destination (Join-Path $staging "$token.xml") -Force
                $r.token = $token
            } else { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            Send-QamJson $Ctx $r; return
        }
        '^/qam/config$' {
            if ($method -eq 'POST') {
                $b = Get-QamBody $req | ConvertFrom-Json
                if ($b.PSObject.Properties.Name -contains 'retentionDays') {
                    $script:Cfg.retentionDays = [int]$b.retentionDays
                    Set-QamEnvValue -Path $EnvFile -Key 'QAM_RAW_RETENTION_DAYS' -Value $script:Cfg.retentionDays
                }
            }
            Send-QamJson $Ctx $script:Cfg; return
        }
        '^/qam/shutdown$' {
            Send-QamJson $Ctx @{ ok = $true }
            $script:QamStop = $true
            return
        }
        default { Send-QamJson $Ctx @{ error = "no route: $path" } 404; return }
    }
}

# ─── 起動 ────────────────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "[qam] listening on $prefix  (DataDir=$DataDir, retention=${RetentionDays}d)" -ForegroundColor Green

while (-not $script:QamStop) {
    try { $ctx = $listener.GetContext() } catch { break }
    try { Invoke-QamRoute $ctx }
    catch { try { Send-QamJson $ctx @{ error = $_.Exception.Message } 500 } catch { } }
}
$listener.Stop()
Write-Host '[qam] stopped' -ForegroundColor Yellow
