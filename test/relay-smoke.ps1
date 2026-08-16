# =============================================================================
# qam-relay.ps1 スモークテスト — relay を起動し health/config を検証
#   実行: pwsh test/relay-smoke.ps1   （fetch は実 Qualys/プロキシが要るので対象外）
# =============================================================================
$ErrorActionPreference = 'Stop'
$port = 18098
$base = "http://127.0.0.1:$port"
$tmp = if ("$PSScriptRoot" -like '\\*') { Join-Path ([IO.Path]::GetTempPath()) 'qam-smoke' } else { Join-Path $PSScriptRoot '.tmp-relay' }
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
$bundle = Join-Path $tmp 'dist'; $envf = Join-Path $tmp 'qam.env'
New-Item -ItemType Directory -Path $bundle -Force | Out-Null
# Resolve-Path は UNC でプロバイダ接頭辞付き（Microsoft.PowerShell.Core\FileSystem::\\…）を返し、
# それを -File に渡すと子プロセスがスクリプトを見つけられない。素のパスを組み立てる。
$relay = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\qam-relay.ps1'

$script:pass = 0; $script:fail = 0
function Assert-Eq($a, $e, $m) { if ("$a" -eq "$e") { $script:pass++; Write-Host "  ok  : $m" -ForegroundColor Green } else { $script:fail++; Write-Host "  FAIL: $m (expected=$e actual=$a)" -ForegroundColor Red } }

# 実行系は環境で違う（Windows は PowerShell 5.1 = powershell.exe、他は pwsh）。
# relay の本番実行環境は Windows PowerShell 5.1 なので、そこで回せることが重要。
$shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
# 作業ディレクトリに UNC パスは指定できない（Win32 制約）。共有(\\…)から実行された場合に
# 子プロセスが起動できないので、cwd は必ずローカルパスにする（qam-launch.ps1 と同じ扱い）。
$cwd = if ("$PSScriptRoot" -like '\\*') { [IO.Path]::GetTempPath() } else { $PSScriptRoot }
$proc = Start-Process $shell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $relay, '-Port', $port, '-BundleDir', $bundle, '-EnvFile', $envf -WorkingDirectory $cwd -PassThru
try {
    $up = $false
    for ($i = 0; $i -lt 30; $i++) { try { if ((Invoke-RestMethod "$base/qam/health" -TimeoutSec 2).ok) { $up = $true; break } } catch { Start-Sleep -Milliseconds 300 } }
    Assert-Eq $up $true 'relay: /qam/health'

    # fetch-batch の worker は別 runspace なので、自前関数を渡し忘れると
    # 「用語 'Get-QamPassword' は認識されません」で取得が失敗する（実際に踏んだ）。
    # 到達不能なホストを指定し、"関数が見つからない" 系のエラーにならないことを検査する。
    $bodyB = @{ kinds = @('group'); base = 'https://qualys.invalid'; user = 'u'; pass = 'p' } | ConvertTo-Json -Compress
    $rb = Invoke-RestMethod "$base/qam/fetch-batch" -Method Post -ContentType 'application/json' -Body $bodyB -TimeoutSec 120
    $item = @($rb.items)[0]
    $missing = [bool]($item.error -match 'Get-Qam|Unprotect-Qam|not recognized|\u8a8d\u8b58\u3055\u308c\u307e\u305b\u3093')
    Assert-Eq $missing $false 'fetch-batch: worker が自前関数を解決できている'

    # config GET/POST
    $cfg = Invoke-RestMethod "$base/qam/config" -Method Post -ContentType 'application/json' -Body (@{ retentionDays = 45; proxy = 'http://px:8080' } | ConvertTo-Json)
    Assert-Eq $cfg.retentionDays 45 'config: retentionDays 永続化'
    Assert-Eq $cfg.proxy 'http://px:8080' 'config: proxy 永続化'

    Invoke-RestMethod "$base/qam/shutdown" -Method Post | Out-Null
}
finally {
    Start-Sleep -Milliseconds 500
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host ""
Write-Host "結果: $script:pass passed / $script:fail failed" -ForegroundColor ($(if ($script:fail -eq 0) { 'Green' } else { 'Red' }))
if ($script:fail -gt 0) { exit 1 }
