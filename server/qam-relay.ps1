# =============================================================================
# qam-relay.ps1 — 薄いローカル中継（Windows PowerShell 5.1 / PowerShell 7 両対応）
# =============================================================================
# ブラウザ(TS アプリ)が出来ないことだけを担う:
#   1) TS バンドル(dist/qam.bundle.js)の配信
#   2) Qualys API を「プロキシ経由 + Basic 認証」で取得（CORS/プロキシ回避）
#   3) UNC データディレクトリ配下のファイル read/write/list/remove
# パース/差分/ストレージ書式の解釈は全て TS 側。relay はパス安全性だけ担保する。
# 127.0.0.1 で listen するので管理者権限不要。設定は 引数 > 環境変数 > qam.env。
#   実行: powershell -ExecutionPolicy Bypass -File qam-relay.ps1   （通常は qam-start.bat 経由）
# =============================================================================
[CmdletBinding()]
param(
    [int]$Port,
    [string]$DataDir,
    [string]$BundleDir,
    [string]$EnvFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http | Out-Null

# ─── env 読込/保存 ───────────────────────────────────────────────────────────
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
if (-not $BundleDir) { $BundleDir = if ($env:QAM_BUNDLE_DIR) { $env:QAM_BUNDLE_DIR } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'dist' } }
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
$DataFull = (Resolve-Path -LiteralPath $DataDir).Path
$script:QamStop = $false

# ─── HTTP ヘルパ ─────────────────────────────────────────────────────────────
function Set-Cors { param($Resp)
    $Resp.Headers['Access-Control-Allow-Origin'] = '*'
    $Resp.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $Resp.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
}
function Send-Bytes { param($Ctx, [byte[]]$Bytes, [string]$Type, [int]$Status = 200)
    $r = $Ctx.Response; Set-Cors $r; $r.StatusCode = $Status; $r.ContentType = $Type
    $r.ContentLength64 = $Bytes.Length; $r.OutputStream.Write($Bytes, 0, $Bytes.Length); $r.OutputStream.Close()
}
function Send-Text { param($Ctx, [string]$Text, [string]$Type = 'text/plain; charset=utf-8', [int]$Status = 200)
    Send-Bytes $Ctx ([Text.Encoding]::UTF8.GetBytes($Text)) $Type $Status
}
function Send-Json { param($Ctx, $Obj, [int]$Status = 200)
    Send-Text $Ctx ($Obj | ConvertTo-Json -Depth 12) 'application/json; charset=utf-8' $Status
}
function Get-Body { param($Req)
    if (-not $Req.HasEntityBody) { return '' }
    $sr = New-Object System.IO.StreamReader($Req.InputStream, $Req.ContentEncoding)
    try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}
# path を DataDir 配下に閉じ込めて解決（.. 等での脱出を拒否）。
function Resolve-SafePath { param([string]$Rel)
    if (-not $Rel) { throw 'path 未指定' }
    $full = [IO.Path]::GetFullPath((Join-Path $DataFull $Rel))
    if (-not $full.StartsWith($DataFull, [StringComparison]::Ordinal)) { throw "範囲外 path: $Rel" }
    return $full
}

# ─── Qualys プロキシ取得 ─────────────────────────────────────────────────────
function Invoke-QualysFetch { param($Body)
    $url = $Body.url
    if (-not $url) {
        $base = $Body.base.TrimEnd('/')
        switch ($Body.kind) {
            'group'  { $url = "$base/api/2.0/fo/asset/group/?action=list&show_attributes=ALL" }
            'host'   { $url = "$base/api/2.0/fo/asset/host/?action=list&details=All&truncation_limit=1000" }
            'domain' { $url = "$base/api/2.0/fo/asset/domain/?action=list" }
            default  { throw "未知 kind: $($Body.kind)" }
        }
    }
    $handler = New-Object System.Net.Http.HttpClientHandler
    if ($Body.proxy) { $handler.Proxy = New-Object System.Net.WebProxy($Body.proxy); $handler.UseProxy = $true }
    $client = New-Object System.Net.Http.HttpClient($handler)
    try {
        $client.DefaultRequestHeaders.Add('X-Requested-With', 'QAM')
        if ($Body.user) {
            $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($Body.user):$($Body.pass)"))
            $client.DefaultRequestHeaders.Add('Authorization', "Basic $b64")
        }
        $resp = $client.GetAsync($url).Result
        $xml = $resp.Content.ReadAsStringAsync().Result
        $next = $null
        $m = [regex]::Match($xml, '<URL><!\[CDATA\[(.*?)\]\]></URL>')
        if ($m.Success) { $next = $m.Groups[1].Value }
        return [ordered]@{ ok = $resp.IsSuccessStatusCode; status = [int]$resp.StatusCode; nextUrl = $next; xml = $xml }
    } finally { $client.Dispose(); $handler.Dispose() }
}

# ─── ルーティング ────────────────────────────────────────────────────────────
$IndexHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QAM — Qualys Asset Management</title></head><body><div id="qam-root"></div><script src="/qam/bundle/qam.bundle.js"></script></body></html>'

function Invoke-Route { param($Ctx)
    $req = $Ctx.Request
    $path = $req.Url.AbsolutePath
    Write-Host ("[qam] {0} {1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $req.HttpMethod, $path) -ForegroundColor DarkGray
    if ($req.HttpMethod -eq 'OPTIONS') { Send-Bytes $Ctx ([byte[]]@()) 'text/plain' 204; return }
    $q = $req.QueryString

    switch -Regex ($path) {
        '^/qam/health$' { Send-Json $Ctx @{ ok = $true; version = '0.1.0-phase1' }; return }
        '^/$' { Send-Text $Ctx $IndexHtml 'text/html; charset=utf-8'; return }
        '^/qam/bundle/(.+)$' {
            $f = Join-Path $BundleDir $Matches[1]
            if (-not (Test-Path -LiteralPath $f)) { Send-Json $Ctx @{ error = 'bundle not built'; hint = 'npm run build' } 404; return }
            $ct = if ($f -match '\.js$') { 'text/javascript; charset=utf-8' } else { 'text/plain; charset=utf-8' }
            Send-Bytes $Ctx ([IO.File]::ReadAllBytes($f)) $ct; return
        }
        '^/qam/fetch$' {
            try { Send-Json $Ctx (Invoke-QualysFetch (Get-Body $req | ConvertFrom-Json)) }
            catch { Send-Json $Ctx @{ ok = $false; error = $_.Exception.Message } 502 }
            return
        }
        '^/qam/file/list$' {
            $dir = Resolve-SafePath $q['dir']
            if (-not (Test-Path -LiteralPath $dir)) { Send-Json $Ctx @{ names = @() }; return }
            Send-Json $Ctx @{ names = @(Get-ChildItem -LiteralPath $dir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }; return
        }
        '^/qam/file/remove$' {
            $p = Resolve-SafePath (Get-Body $req | ConvertFrom-Json).path
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
            Send-Json $Ctx @{ ok = $true }; return
        }
        '^/qam/file$' {
            if ($req.HttpMethod -eq 'POST') {
                $b = Get-Body $req | ConvertFrom-Json
                $p = Resolve-SafePath $b.path
                $dir = Split-Path $p -Parent
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                if ($b.append) { Add-Content -LiteralPath $p -Value $b.content -Encoding UTF8 -NoNewline }
                else { Set-Content -LiteralPath $p -Value $b.content -Encoding UTF8 -NoNewline }
                Send-Json $Ctx @{ ok = $true }; return
            }
            $p = Resolve-SafePath $q['path']
            if (-not (Test-Path -LiteralPath $p)) { Send-Json $Ctx @{ content = $null } 404; return }
            Send-Json $Ctx @{ content = (Get-Content -LiteralPath $p -Raw -Encoding UTF8) }; return
        }
        '^/qam/config$' {
            if ($req.HttpMethod -eq 'POST') {
                $b = Get-Body $req | ConvertFrom-Json
                if ($b.PSObject.Properties.Name -contains 'retentionDays') { Set-QamEnvValue $EnvFile 'QAM_RAW_RETENTION_DAYS' ([int]$b.retentionDays) }
                if ($b.PSObject.Properties.Name -contains 'proxy') { Set-QamEnvValue $EnvFile 'QAM_PROXY_URL' $b.proxy }
                if ($b.PSObject.Properties.Name -contains 'qualysBase') { Set-QamEnvValue $EnvFile 'QAM_QUALYS_API_BASE' $b.qualysBase }
                if ($b.PSObject.Properties.Name -contains 'qualysUser') { Set-QamEnvValue $EnvFile 'QAM_QUALYS_USER' $b.qualysUser }
                Import-QamEnv $EnvFile
            }
            Send-Json $Ctx @{
                qualysBase = $env:QAM_QUALYS_API_BASE; qualysUser = $env:QAM_QUALYS_USER
                proxy = $env:QAM_PROXY_URL; port = $Port
                retentionDays = if ($env:QAM_RAW_RETENTION_DAYS) { [int]$env:QAM_RAW_RETENTION_DAYS } else { 90 }
            }; return
        }
        '^/qam/shutdown$' { Send-Json $Ctx @{ ok = $true }; $script:QamStop = $true; return }
        default { Send-Json $Ctx @{ error = "no route: $path" } 404; return }
    }
}

# ─── 起動 ────────────────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "[qam] relay listening on $prefix  (DataDir=$DataFull, BundleDir=$BundleDir)" -ForegroundColor Green

while (-not $script:QamStop) {
    try { $ctx = $listener.GetContext() } catch { break }
    try { Invoke-Route $ctx } catch { try { Send-Json $ctx @{ error = $_.Exception.Message } 500 } catch { } }
}
$listener.Stop()
Write-Host '[qam] relay stopped' -ForegroundColor Yellow
