# =============================================================================
# QAM サーバ スモークテスト（pwsh）— サーバを起動し全 API を叩いて検証
#   実行: pwsh test/run-server-test.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$port = 18097
$base = "http://127.0.0.1:$port"
$tmp = Join-Path $PSScriptRoot '.tmp-srv'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$server = Resolve-Path "$PSScriptRoot/../server/qam-server.ps1"

$script:pass = 0; $script:fail = 0
function Assert-Eq($actual, $expected, $msg) {
    if ("$actual" -eq "$expected") { $script:pass++; Write-Host "  ok  : $msg" -ForegroundColor Green }
    else { $script:fail++; Write-Host "  FAIL: $msg (expected=$expected actual=$actual)" -ForegroundColor Red }
}

$grp1 = @'
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><DATETIME>2026-06-12T00:00:00Z</DATETIME><ASSET_GROUP_LIST>
<ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>1</OWNER_ID>
<IP_SET><IP>10.0.0.1</IP></IP_SET></ASSET_GROUP>
<ASSET_GROUP><ID>200</ID><TITLE><![CDATA[Stage]]></TITLE><OWNER_ID>1</OWNER_ID></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>
'@
$grp2 = @'
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><DATETIME>2026-06-13T00:00:00Z</DATETIME><ASSET_GROUP_LIST>
<ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>2</OWNER_ID>
<IP_SET><IP>10.0.0.1</IP><IP>10.0.0.9</IP></IP_SET></ASSET_GROUP>
<ASSET_GROUP><ID>300</ID><TITLE><![CDATA[New]]></TITLE><OWNER_ID>1</OWNER_ID></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>
'@
$grpEmpty = @'
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><DATETIME>2026-06-14T00:00:00Z</DATETIME><ASSET_GROUP_LIST>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>
'@

$envFile = Join-Path $tmp 'qam.env'  # 実 server/qam.env を汚さないよう temp env を使う
$proc = Start-Process pwsh -ArgumentList '-NoProfile', '-File', $server, '-Port', $port, '-DataDir', $tmp, '-EnvFile', $envFile -PassThru
try {
    # health 待機
    $up = $false
    for ($i = 0; $i -lt 30; $i++) {
        try { if ((Invoke-RestMethod "$base/qam/health" -TimeoutSec 2).ok) { $up = $true; break } } catch { Start-Sleep -Milliseconds 300 }
    }
    Assert-Eq $up $true 'server: /qam/health 応答'

    # 取込 day1 → day2
    $r1 = Invoke-RestMethod "$base/qam/ingest?entity=group" -Method Post -Body $grp1 -ContentType 'application/xml'
    Assert-Eq $r1.committed $true 'ingest: day1 commit'
    Assert-Eq $r1.date '2026-06-12' 'ingest: 日付は XML DATETIME 由来'
    $r2 = Invoke-RestMethod "$base/qam/ingest?entity=group" -Method Post -Body $grp2 -ContentType 'application/xml'
    Assert-Eq $r2.added 1 'ingest: day2 added=1'
    Assert-Eq $r2.deleted 1 'ingest: day2 deleted=1'
    Assert-Eq $r2.modified 2 'ingest: day2 modified=2 (OWNER_ID/IPS)'

    # 現況（最新=2026-06-13）
    $cur = Invoke-RestMethod "$base/qam/current?entity=group"
    Assert-Eq $cur.date '2026-06-13' 'current: 最新日付'
    Assert-Eq @($cur.records).Count 2 'current: 2 件 (AG100/AG300)'

    # 指定日（2026-06-12）
    $cur12 = Invoke-RestMethod "$base/qam/current?entity=group&asof=2026-06-12"
    Assert-Eq $cur12.date '2026-06-12' 'current: asof=2026-06-12'
    Assert-Eq @($cur12.records).Count 2 'current: day1 は AG100/AG200'

    # 保存期間外
    $curOld = Invoke-RestMethod "$base/qam/current?entity=group&asof=2020-01-01"
    Assert-Eq $curOld.outOfRange $true 'current: 期間外フラグ'

    # 履歴
    $hist = Invoke-RestMethod "$base/qam/history?entity=group"
    Assert-Eq (@($hist.events | Where-Object { $_.change -eq 'added' }).Count) 1 'history: added 1 件'

    # dates
    $dates = Invoke-RestMethod "$base/qam/dates?entity=group"
    Assert-Eq (@($dates.dates).Count) 2 'dates: 2 日分'

    # コメント
    Invoke-RestMethod "$base/qam/comment" -Method Post -ContentType 'application/json' -Body (@{ entity = 'group'; id = '100'; author = 't'; text = 'メモ' } | ConvertTo-Json) | Out-Null
    $cm = Invoke-RestMethod "$base/qam/comments?entity=group&id=100"
    Assert-Eq @($cm.comments).Count 1 'comment: 1 件取得'
    Assert-Eq $cm.comments[0].text 'メモ' 'comment: 本文一致'

    # 急減ガード（空リスト）→ needsConfirm → confirm で確定
    $rg = Invoke-RestMethod "$base/qam/ingest?entity=group" -Method Post -Body $grpEmpty -ContentType 'application/xml'
    Assert-Eq $rg.guard $true 'guard: 空リストで guard 発火'
    Assert-Eq $rg.committed $false 'guard: 未コミット'
    $rc = Invoke-RestMethod "$base/qam/ingest/confirm" -Method Post -ContentType 'application/json' -Body (@{ token = $rg.token } | ConvertTo-Json)
    Assert-Eq $rc.committed $true 'guard: confirm で確定'
    Assert-Eq $rc.deleted 2 'guard: confirm で 2 件 deleted'

    # config（保存期間変更）
    $cfg = Invoke-RestMethod "$base/qam/config" -Method Post -ContentType 'application/json' -Body (@{ retentionDays = 30 } | ConvertTo-Json)
    Assert-Eq $cfg.retentionDays 30 'config: retentionDays=30 反映'

    # shutdown
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
