# =============================================================================
# QAM ワンクリック起動 (Windows / Windows PowerShell 5.1 準拠)
# =============================================================================
# 1) relay (qam-relay.ps1) が未起動なら別ウィンドウ + -NoExit で起動
# 2) /qam/health が 200 になるまで最大 10 秒待機
# 3) server\qam-launch.ps1 へ委譲し、専用プロファイルの Edge で SharePoint を開いて
#    CDP でアプリを注入する
#
# 管理データは SharePoint に置くので、アプリは **SharePoint のページ上でしか動かない**
# （サインイン情報を使うため）。ローカルの画面（http://127.0.0.1:<port>/）を開いても
# 保管先に接続できないので、そこへは開かない。
# 起動: エクスプローラで qam-start.bat をダブルクリック
# =============================================================================
[CmdletBinding()]
param([int]$Port, [string]$EnvFile)
$ErrorActionPreference = 'Stop'
trap {
    Write-Host ''
    Write-Host "[qam-start] 予期しないエラーで終了します: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host '何かキーを押して終了'
    exit 1
}

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot 'server\qam.env' }
# qam.env から値を1つ読む（引数 > qam.env の順で使う）。
function Get-EnvValue {
    param([string]$Key)
    if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
    foreach ($l in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
        $t = $l.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('='); if ($eq -lt 1) { continue }
        if ($t.Substring(0, $eq).Trim() -eq $Key) { return $t.Substring($eq + 1).Trim().Trim('"').Trim("'") }
    }
    return ''
}

# ポート解決: 引数 > qam.env の QAM_RELAY_PORT > 既定 18090
if (-not $Port) { $p = Get-EnvValue 'QAM_RELAY_PORT'; if ($p -match '^\d+$') { $Port = [int]$p } }
if (-not $Port) { $Port = 18090 }
$health = "http://127.0.0.1:$Port/qam/health"

function Test-Up {
    param([string]$Url)
    try { return ((Invoke-WebRequest -Uri $Url -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop).StatusCode -eq 200) }
    catch { return $false }
}

if (Test-Up $health) {
    Write-Host "[qam-start] relay は既に起動済み (port $Port)" -ForegroundColor Green
} else {
    $relay = Join-Path $PSScriptRoot 'server\qam-relay.ps1'
    if (-not (Test-Path -LiteralPath $relay)) { throw "relay が見つかりません: $relay" }
    Write-Host "[qam-start] relay を起動 (port $Port)..." -ForegroundColor Cyan
    # プロセスの作業ディレクトリに UNC パスは指定できない（Win32 制約）。共有(\\…)から起動された場合は
    # ローカルパスにフォールバックする。relay は $PSScriptRoot と絶対パスで動くので作業Dirに依存しない。
    $relayCwd = if ($PSScriptRoot -like '\\*') { $env:SystemRoot } else { $PSScriptRoot }
    # 別ウィンドウ + -NoExit。起動失敗(ポート競合/設定不足)が見えるように隠さない。
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$relay`""
    ) -WorkingDirectory $relayCwd | Out-Null
    $w = 0
    while ($w -lt 10000 -and -not (Test-Up $health)) { Start-Sleep -Milliseconds 500; $w += 500 }
    if (Test-Up $health) { Write-Host "[qam-start] relay OK" -ForegroundColor Green }
    else { Write-Host "[qam-start] 警告: relay の起動応答を確認できませんでした。別ウィンドウのログを確認してください (QAM_DATA_DIR 未設定等)。" -ForegroundColor Yellow }
}

# 管理データは SharePoint にあるので、必ず SharePoint のページ上で起動する。
$launch = Join-Path $PSScriptRoot 'server\qam-launch.ps1'
if (-not (Test-Path -LiteralPath $launch)) {
    Write-Host "[qam-start] 起動スクリプトが見つかりません: $launch" -ForegroundColor Red
    Write-Host '[qam-start] 配布物が不完全です（server\qam-launch.ps1 が必要）' -ForegroundColor Red
    Read-Host '終了するには Enter'
    exit 1
}
Write-Host '[qam-start] SharePoint のページで開きます' -ForegroundColor Cyan
& $launch -RelayPort $Port
