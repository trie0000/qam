# =============================================================================
# QAM コアエンジン回帰テスト（pwsh）
#   parse(QUALYS_XML.md準拠) → snapshot保存 → 差分 → asof/prune/comment/guard
#   実行: pwsh test/run-tests.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot/../server/qam-store.ps1"
. "$PSScriptRoot/../server/qam-ingest.ps1"
. "$PSScriptRoot/../server/qam-diff.ps1"

$tmp = Join-Path $PSScriptRoot '.tmp'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
$data = Join-Path $tmp 'data'
$xmls = Join-Path $tmp 'xml'
New-Item -ItemType Directory -Path $xmls -Force | Out-Null
Initialize-QamStore $data | Out-Null

$script:pass = 0; $script:fail = 0
function Assert-Eq($actual, $expected, $msg) {
    if ("$actual" -eq "$expected") { $script:pass++; Write-Host "  ok  : $msg" -ForegroundColor Green }
    else { $script:fail++; Write-Host "  FAIL: $msg (expected=$expected actual=$actual)" -ForegroundColor Red }
}
function Write-Xml($name, $content) {
    $p = Join-Path $xmls $name
    Set-Content -LiteralPath $p -Value $content -Encoding UTF8
    return $p
}
# parse → (前回スナップショットと差分) → snapshot保存 + history追記。events を返す。
function Invoke-TestIngest($entity, $path, $date) {
    $parsed = ConvertFrom-QamXml -Path $path -Entity $entity
    $prevDate = Resolve-QamAsofDate -DataDir $data -Entity $entity -Asof $null
    $prev = $null
    if ($prevDate) { $prev = (Read-QamSnapshot -DataDir $data -Entity $entity -Date $prevDate).records }
    Write-QamSnapshot -DataDir $data -Entity $entity -Date $date -Snapshot @{ date = $date; entity = $entity; records = $parsed.records }
    $events = Compare-QamSnapshots -Prev $prev -Curr $parsed.records -Entity $entity -Date $date
    Add-QamHistory -DataDir $data -Entity $entity -Events $events
    return $events
}
function Count($events, $change) { @($events | Where-Object { $_.change -eq $change }).Count }
# StrictMode 下では存在しないキーへのメンバアクセスが例外。Contains で守ってから絞る。
function ByField($events, $f) { @($events | Where-Object { $_.Contains('field') -and $_.field -eq $f }) }

# ---------------------------------------------------------------------------
# AssetGroup
# ---------------------------------------------------------------------------
$g1 = Write-Xml 'group-1.xml' @'
<?xml version="1.0" encoding="UTF-8" ?>
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST>
  <ASSET_GROUP>
    <ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>1</OWNER_ID>
    <IP_SET><IP>10.0.0.1</IP><IP_RANGE>10.0.0.0-10.0.0.5</IP_RANGE></IP_SET>
    <DNS_LIST><DNS>a.example</DNS></DNS_LIST>
  </ASSET_GROUP>
  <ASSET_GROUP>
    <ID>200</ID><TITLE><![CDATA[Stage]]></TITLE><OWNER_ID>1</OWNER_ID>
    <IP_SET><IP>10.0.1.1</IP></IP_SET>
  </ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>
'@
$g2 = Write-Xml 'group-2.xml' @'
<?xml version="1.0" encoding="UTF-8" ?>
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST>
  <ASSET_GROUP>
    <ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>2</OWNER_ID>
    <IP_SET><IP>10.0.0.1</IP><IP_RANGE>10.0.0.0-10.0.0.5</IP_RANGE><IP>10.0.0.9</IP></IP_SET>
    <DNS_LIST><DNS>a.example</DNS><DNS>b.example</DNS></DNS_LIST>
  </ASSET_GROUP>
  <ASSET_GROUP>
    <ID>300</ID><TITLE><![CDATA[NewGrp]]></TITLE><OWNER_ID>1</OWNER_ID>
    <IP_SET><IP>10.0.2.1</IP></IP_SET>
  </ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>
'@
$gp = ConvertFrom-QamXml -Path $g1 -Entity $null
Assert-Eq $gp.entity 'group' 'group: ルートから entity 自動判定'
Assert-Eq $gp.records['100'].set['IPS'].Count 2 'group: IPS = IP + IP_RANGE で 2 件'
Assert-Eq ($gp.records['100'].set['DNS_LIST'] -join ',') 'a.example' 'group: DNS_LIST パース'
Invoke-TestIngest 'group' $g1 '2026-06-12' | Out-Null
$ge = Invoke-TestIngest 'group' $g2 '2026-06-13'
Assert-Eq (Count $ge 'added')    1 'group: added=1 (AG300)'
Assert-Eq (Count $ge 'deleted')  1 'group: deleted=1 (AG200)'
Assert-Eq (Count $ge 'modified') 3 'group: modified=3 (OWNER_ID / IPS / DNS_LIST)'
$ipsEvt = @(ByField $ge 'IPS')[0]
Assert-Eq ($ipsEvt.added -join ',') '10.0.0.9' 'group: IPS added=10.0.0.9'
Assert-Eq (@($ipsEvt.removed).Count) 0 'group: IPS removed=0'

# ---------------------------------------------------------------------------
# Host
# ---------------------------------------------------------------------------
$h1 = Write-Xml 'host-1.xml' @'
<?xml version="1.0" encoding="UTF-8" ?>
<HOST_LIST_OUTPUT><RESPONSE><HOST_LIST>
  <HOST><ID>1</ID><IP>10.0.0.1</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web01.example</FQDN></DNS_DATA><OS><![CDATA[Linux 3]]></OS></HOST>
  <HOST><ID>2</ID><IP>10.0.0.2</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web02.example</FQDN></DNS_DATA><OS><![CDATA[Linux 3]]></OS></HOST>
</HOST_LIST></RESPONSE></HOST_LIST_OUTPUT>
'@
$h2 = Write-Xml 'host-2.xml' @'
<?xml version="1.0" encoding="UTF-8" ?>
<HOST_LIST_OUTPUT><RESPONSE><HOST_LIST>
  <HOST><ID>1</ID><IP>10.0.0.1</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web01.example</FQDN></DNS_DATA><OS><![CDATA[Windows]]></OS></HOST>
  <HOST><ID>3</ID><IP>10.0.0.3</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web03.example</FQDN></DNS_DATA><OS><![CDATA[Linux 3]]></OS></HOST>
</HOST_LIST></RESPONSE></HOST_LIST_OUTPUT>
'@
$hp = ConvertFrom-QamXml -Path $h1 -Entity $null
Assert-Eq $hp.entity 'host' 'host: entity 自動判定'
Assert-Eq $hp.records['1'].name 'web01.example' 'host: name = FQDN'
Invoke-TestIngest 'host' $h1 '2026-06-12' | Out-Null
$he = Invoke-TestIngest 'host' $h2 '2026-06-13'
Assert-Eq (Count $he 'added')    1 'host: added=1 (HOST3)'
Assert-Eq (Count $he 'deleted')  1 'host: deleted=1 (HOST2)'
Assert-Eq (Count $he 'modified') 1 'host: modified=1 (OS)'
Assert-Eq (@(ByField $he 'OS')[0].new) 'Windows' 'host: OS new=Windows'

# ---------------------------------------------------------------------------
# Domain
# ---------------------------------------------------------------------------
$d1 = Write-Xml 'domain-1.xml' @'
<?xml version="1.0" encoding="UTF-8" ?>
<DOMAIN_LIST>
  <DOMAIN><DOMAIN_NAME>example.com</DOMAIN_NAME><DOMAIN_ID>10</DOMAIN_ID>
    <NETBLOCK><RANGE><START>10.0.0.0</START><END>10.0.0.255</END></RANGE></NETBLOCK></DOMAIN>
</DOMAIN_LIST>
'@
$d2 = Write-Xml 'domain-2.xml' @'
<?xml version="1.0" encoding="UTF-8" ?>
<DOMAIN_LIST>
  <DOMAIN><DOMAIN_NAME>example.com</DOMAIN_NAME><DOMAIN_ID>10</DOMAIN_ID>
    <NETBLOCK><RANGE><START>10.0.0.0</START><END>10.0.0.255</END></RANGE>
             <RANGE><START>10.0.1.0</START><END>10.0.1.255</END></RANGE></NETBLOCK></DOMAIN>
  <DOMAIN><DOMAIN_NAME>new.example</DOMAIN_NAME><DOMAIN_ID>11</DOMAIN_ID></DOMAIN>
</DOMAIN_LIST>
'@
$dp = ConvertFrom-QamXml -Path $d1 -Entity $null
Assert-Eq $dp.entity 'domain' 'domain: entity 自動判定'
Assert-Eq $dp.records['example.com'].set['NETBLOCK'][0] '10.0.0.0-10.0.0.255' 'domain: NETBLOCK パース'
Invoke-TestIngest 'domain' $d1 '2026-06-12' | Out-Null
$de = Invoke-TestIngest 'domain' $d2 '2026-06-13'
Assert-Eq (Count $de 'added')    1 'domain: added=1 (new.example)'
Assert-Eq (Count $de 'modified') 1 'domain: modified=1 (NETBLOCK)'
Assert-Eq (@(ByField $de 'NETBLOCK')[0].added -join ',') '10.0.1.0-10.0.1.255' 'domain: NETBLOCK added'

# ---------------------------------------------------------------------------
# 指定日参照（asof）
# ---------------------------------------------------------------------------
Assert-Eq (Resolve-QamAsofDate -DataDir $data -Entity 'group' -Asof $null) '2026-06-13' 'asof: 未指定→最新'
Assert-Eq (Resolve-QamAsofDate -DataDir $data -Entity 'group' -Asof '2026-06-12') '2026-06-12' 'asof: 当日'
Assert-Eq (Resolve-QamAsofDate -DataDir $data -Entity 'group' -Asof '2026-06-20') '2026-06-13' 'asof: 未来→直前最大'
Assert-Eq ([string](Resolve-QamAsofDate -DataDir $data -Entity 'group' -Asof '2026-06-01')) '' 'asof: 保存期間前→null'

# ---------------------------------------------------------------------------
# 剪定（prune）— history は残す
# ---------------------------------------------------------------------------
Write-QamSnapshot -DataDir $data -Entity 'group' -Date '2026-01-01' -Snapshot @{ date = '2026-01-01'; entity = 'group'; records = @{} }
$removed = Invoke-QamPrune -DataDir $data -RetentionDays 30 -RefDate ([datetime]'2026-06-13')
Assert-Eq ($removed -contains 'group/2026-01-01') 'True' 'prune: 古い 2026-01-01 を削除'
Assert-Eq ($removed -contains 'group/2026-06-12') 'False' 'prune: 期間内 2026-06-12 は保持'
Assert-Eq (Test-Path -LiteralPath (Join-Path $data 'history/group.jsonl')) 'True' 'prune: history は剪定しない'

# ---------------------------------------------------------------------------
# コメント（資産単位）
# ---------------------------------------------------------------------------
Add-QamComment -DataDir $data -Entity 'host' -Id '1' -Author 'tester' -Text '対応済み' -Ts '2026-06-13T09:00:00Z'
Add-QamComment -DataDir $data -Entity 'host' -Id '3' -Author 'tester' -Text '別件' -Ts '2026-06-13T09:01:00Z'
Assert-Eq (@(Read-QamComments -DataDir $data -Entity 'host' -Id '1').Count) 1 'comment: host/1 を1件取得'
Assert-Eq ((Read-QamComments -DataDir $data -Entity 'host' -Id '1').text) '対応済み' 'comment: 本文一致'

# ---------------------------------------------------------------------------
# 件数急減ガード
# ---------------------------------------------------------------------------
Assert-Eq (Test-QamShrinkGuard -PrevCount 100 -CurrCount 40 -Ratio 0.5) 'True'  'guard: 60%減→要確認'
Assert-Eq (Test-QamShrinkGuard -PrevCount 100 -CurrCount 80 -Ratio 0.5) 'False' 'guard: 20%減→OK'
Assert-Eq (Test-QamShrinkGuard -PrevCount 100 -CurrCount 0  -Ratio 0.5) 'True'  'guard: 0件→要確認'
Assert-Eq (Test-QamShrinkGuard -PrevCount 0   -CurrCount 0  -Ratio 0.5) 'False' 'guard: 初回(baseline無)→OK'

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "結果: $script:pass passed / $script:fail failed" -ForegroundColor ($(if ($script:fail -eq 0) { 'Green' } else { 'Red' }))
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
if ($script:fail -gt 0) { exit 1 }
