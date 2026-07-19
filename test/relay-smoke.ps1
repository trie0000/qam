# =============================================================================
# qam-relay.ps1 スモークテスト — relay を起動し file/config/health/path安全性を検証
#   実行: pwsh test/relay-smoke.ps1   （fetch は実 Qualys/プロキシが要るので対象外）
# =============================================================================
$ErrorActionPreference = 'Stop'
$port = 18098
$base = "http://127.0.0.1:$port"
$tmp = Join-Path $PSScriptRoot '.tmp-relay'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
$data = Join-Path $tmp 'data'; $bundle = Join-Path $tmp 'dist'; $envf = Join-Path $tmp 'qam.env'
New-Item -ItemType Directory -Path $data, $bundle -Force | Out-Null
$relay = Resolve-Path "$PSScriptRoot/../server/qam-relay.ps1"

$script:pass = 0; $script:fail = 0
function Assert-Eq($a, $e, $m) { if ("$a" -eq "$e") { $script:pass++; Write-Host "  ok  : $m" -ForegroundColor Green } else { $script:fail++; Write-Host "  FAIL: $m (expected=$e actual=$a)" -ForegroundColor Red } }

$proc = Start-Process pwsh -ArgumentList '-NoProfile', '-File', $relay, '-Port', $port, '-DataDir', $data, '-BundleDir', $bundle, '-EnvFile', $envf -PassThru
try {
    $up = $false
    for ($i = 0; $i -lt 30; $i++) { try { if ((Invoke-RestMethod "$base/qam/health" -TimeoutSec 2).ok) { $up = $true; break } } catch { Start-Sleep -Milliseconds 300 } }
    Assert-Eq $up $true 'relay: /qam/health'

    # file write → read
    Invoke-RestMethod "$base/qam/file" -Method Post -ContentType 'application/json' -Body (@{ path = 'snapshots/group/2026-06-12.json'; content = '{"a":1}' } | ConvertTo-Json) | Out-Null
    $r = Invoke-RestMethod "$base/qam/file?path=snapshots/group/2026-06-12.json"
    Assert-Eq $r.content '{"a":1}' 'file: write→read'

    # append
    Invoke-RestMethod "$base/qam/file" -Method Post -ContentType 'application/json' -Body (@{ path = 'history/group.jsonl'; content = "L1`n" } | ConvertTo-Json) | Out-Null
    Invoke-RestMethod "$base/qam/file" -Method Post -ContentType 'application/json' -Body (@{ path = 'history/group.jsonl'; content = "L2`n"; append = $true } | ConvertTo-Json) | Out-Null
    $h = Invoke-RestMethod "$base/qam/file?path=history/group.jsonl"
    Assert-Eq ($h.content.Trim() -replace "`r", '') "L1`nL2" 'file: append'

    # list
    $l = Invoke-RestMethod "$base/qam/file/list?dir=snapshots/group"
    Assert-Eq (@($l.names).Count) 1 'file/list: 1 件'

    # remove
    Invoke-RestMethod "$base/qam/file/remove" -Method Post -ContentType 'application/json' -Body (@{ path = 'snapshots/group/2026-06-12.json' } | ConvertTo-Json) | Out-Null
    $l2 = Invoke-RestMethod "$base/qam/file/list?dir=snapshots/group"
    Assert-Eq (@($l2.names).Count) 0 'file/remove: 削除'

    # path 安全性（範囲外は拒否）
    $blocked = $false
    try { Invoke-RestMethod "$base/qam/file?path=../../escape.txt" -TimeoutSec 3 } catch { $blocked = $true }
    Assert-Eq $blocked $true 'safety: ../ 脱出を拒否'

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
