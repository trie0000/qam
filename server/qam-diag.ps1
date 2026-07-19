# =============================================================================
# qam-diag.ps1 — 起動しないときに、どこで止まっているかを切り分ける
# 使い方: powershell -NoProfile -ExecutionPolicy Bypass -File server\qam-diag.ps1
# =============================================================================
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
function Chk { param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $mark = if ($Ok) { 'OK  ' } else { 'NG  ' }
    $color = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("{0}{1}{2}" -f $mark, $Name.PadRight(34), $Detail) -ForegroundColor $color
}
Write-Host '--- QAM 起動診断 ---' -ForegroundColor Cyan

# 1) 配布物
$relay  = Join-Path $Root 'qam-relay.ps1'
$launch = Join-Path $Root 'qam-launch.ps1'
$envf   = Join-Path $Root 'qam.env'
Chk 'qam-relay.ps1 がある'  (Test-Path $relay)  $relay
Chk 'qam-launch.ps1 がある' (Test-Path $launch) $launch
Chk 'qam.env がある'        (Test-Path $envf)   $envf

# 2) 設定
function GetEnv { param([string]$K)
    if (-not (Test-Path $envf)) { return '' }
    foreach ($l in (Get-Content $envf -Encoding UTF8)) {
        $t = $l.Trim(); if (-not $t -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('='); if ($i -lt 1) { continue }
        if ($t.Substring(0,$i).Trim() -eq $K) { return $t.Substring($i+1).Trim().Trim('"').Trim("'") }
    }
    return ''
}
$site = GetEnv 'QAM_SP_SITE_URL'
$port = GetEnv 'QAM_RELAY_PORT'; if (-not $port) { $port = '18090' }
Chk 'QAM_SP_SITE_URL が設定済み' ([bool]$site) $(if ($site) { $site } else { '未設定 → これが原因なら Edge は起動しません' })
Chk 'QAM_RELAY_PORT'             $true          $port

# 3) Edge
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
Chk 'Edge がある' (Test-Path $edge) $edge
$running = @(Get-Process msedge -ErrorAction SilentlyContinue).Count
Chk 'Edge の起動状況' $true "$running プロセス（多数動いていても専用プロファイルは別で起動します）"

# 4) 中継サーバ
$health = "http://127.0.0.1:$port/qam/health"
$up = $false
try { $null = Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2; $up = $true } catch { }
Chk '中継サーバが応答' $up $health

# 5) デバッグポート
$dbg = 18099
$dbgUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$dbg/json/version" -TimeoutSec 2; $dbgUp = $true } catch { }
Chk 'デバッグポートの状態' $true $(if ($dbgUp) { "$dbg は応答あり（専用ブラウザが既に起動中）" } else { "$dbg は未応答（未起動。正常な初期状態）" })

# 6) 専用プロファイル
$prof = Join-Path $env:LOCALAPPDATA 'qam-edge'
Chk '専用プロファイル' $true $(if (Test-Path $prof) { "あり: $prof" } else { "なし（初回起動時に作成されます）: $prof" })

# 7) 直近のログ
$log = Join-Path $Root 'qam-launch.log'
if (Test-Path $log) {
    Write-Host ''
    Write-Host "--- qam-launch.log の末尾 20 行 ---" -ForegroundColor Cyan
    Get-Content $log -Tail 20
} else {
    Write-Host ''
    Write-Host "ログはまだありません（$log）。qam-start.bat を一度実行してから、もう一度この診断を実行してください。" -ForegroundColor Yellow
}
Write-Host ''
Read-Host '終了するには Enter'
