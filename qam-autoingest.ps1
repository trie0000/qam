# =============================================================================
# QAM 自動取込（無人）— Edge ヘッドレス × 自動取込モード（Windows PowerShell 5.1 準拠）
# =============================================================================
# タスクスケジューラから「取込したい時刻」に起動する想定。流れ:
#   1) data フォルダを見て、対象種別すべて当日スナップショットが既にあれば起動キャンセル（何もしない）
#   2) relay が未起動なら起動
#   3) Edge ヘッドレスで http://127.0.0.1:<port>/?autoingest=<種別> を開く
#      → アプリが（バックアップ→）当日未取込の種別だけを無人取込
#   4) data フォルダを監視し、当日スナップショットが揃ったら（or 上限時間で）Edge を終了
#
# 事前準備（1回だけ）: 認証情報はヘッドレスが使う専用 Edge プロファイルの localStorage に保存する。
#   下記 -ProfileDir と同じパスを指定して通常起動し、ツールの設定で Qualys アカウント/パスワードを保存:
#     msedge.exe --user-data-dir="%LOCALAPPDATA%\qam-edge-profile" http://127.0.0.1:18090/
#
# 例（タスクスケジューラの操作）:
#   プログラム: powershell.exe
#   引数: -NoProfile -ExecutionPolicy Bypass -File "<共有>\qam-autoingest.ps1"
# =============================================================================
[CmdletBinding()]
param(
    [int]$Port,
    [string]$EnvFile,
    [string]$Kinds = 'host,group,domain,user',  # 取込対象（CSV）
    [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA 'qam-edge-profile'),
    [int]$MaxWaitSec = 2400,                     # 完了待ちの上限（既定40分。user取込は長い）
    [int]$PollSec = 15
)
$ErrorActionPreference = 'Stop'

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot 'server\qam.env' }
# qam.env から Port / DataDir を解決。
$DataDir = $env:QAM_DATA_DIR
if (Test-Path -LiteralPath $EnvFile) {
    foreach ($l in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
        if (-not $Port -and $l -match '^\s*QAM_RELAY_PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
        if (-not $DataDir -and $l -match '^\s*QAM_DATA_DIR\s*=\s*(.+?)\s*$') { $DataDir = $Matches[1].Trim('"').Trim("'") }
    }
}
if (-not $Port) { $Port = 18090 }
if (-not $DataDir) { Write-Host '[qam-auto] QAM_DATA_DIR を解決できません。qam.env を確認してください。' -ForegroundColor Red; exit 2 }
$DataFull = ([string]$DataDir).TrimEnd('\', '/')
$today = (Get-Date).ToString('yyyy-MM-dd')
$kindList = @($Kinds.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Test-TodaySnapshot {
    param([string]$Entity)
    $dir = Join-Path (Join-Path $DataFull 'snapshots') $Entity
    if (-not (Test-Path -LiteralPath $dir)) { return $false }
    return @(Get-ChildItem -LiteralPath $dir -Filter "$today`T*.json" -ErrorAction SilentlyContinue).Count -gt 0
}
function Test-AllDone { foreach ($k in $kindList) { if (-not (Test-TodaySnapshot $k)) { return $false } } return $true }

function Add-AutoLog { param([string]$Text)
    try { Add-Content -LiteralPath (Join-Path $DataFull 'autoingest.log') -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) -Encoding UTF8 } catch { }
    Write-Host "[qam-auto] $Text"
}

# (1) 当日分が揃っていれば起動キャンセル。
if (Test-AllDone) { Add-AutoLog "本日($today)分は取込済み。起動をキャンセルしました。"; exit 0 }

# (2) relay 起動確認（未起動なら起動）。
$health = "http://127.0.0.1:$Port/qam/health"
function Test-Up { param([string]$Url) try { return ((Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop).StatusCode -eq 200) } catch { return $false } }
if (-not (Test-Up $health)) {
    $relay = Join-Path $PSScriptRoot 'server\qam-relay.ps1'
    if (-not (Test-Path -LiteralPath $relay)) { Add-AutoLog "relay が見つかりません: $relay"; exit 3 }
    $relayCwd = if ($PSScriptRoot -like '\\*') { $env:SystemRoot } else { $PSScriptRoot }
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$relay`"") -WorkingDirectory $relayCwd -WindowStyle Hidden | Out-Null
    $w = 0; while ($w -lt 15000 -and -not (Test-Up $health)) { Start-Sleep -Milliseconds 500; $w += 500 }
    if (-not (Test-Up $health)) { Add-AutoLog 'relay の起動を確認できませんでした。'; exit 4 }
}

# (3) Edge ヘッドレスで自動取込モードを開く。
$edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { Add-AutoLog 'msedge.exe が見つかりません。Edge のパスを確認してください。'; exit 5 }
$url = "http://127.0.0.1:$Port/?autoingest=$($kindList -join ',')"
Add-AutoLog "Edge ヘッドレスで自動取込を開始: $url (profile=$ProfileDir)"
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    "--user-data-dir=$ProfileDir", $url
)

# (4) 当日スナップショットが揃う or 上限時間まで監視 → Edge を終了。
$waited = 0
while ($waited -lt $MaxWaitSec) {
    Start-Sleep -Seconds $PollSec; $waited += $PollSec
    if (Test-AllDone) { Add-AutoLog "全対象の当日スナップショットを確認。完了（${waited}s）。"; break }
    if ($proc.HasExited) { Add-AutoLog "Edge が終了しました（${waited}s）。"; break }
}
if ($waited -ge $MaxWaitSec) { Add-AutoLog "上限時間（${MaxWaitSec}s）に達したため打ち切ります。" }

# Edge プロセスツリーを終了（ヘッドレスは子プロセスを残すため /T で確実に）。
try { if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } } catch { }
Add-AutoLog '自動取込ランを終了しました。'
