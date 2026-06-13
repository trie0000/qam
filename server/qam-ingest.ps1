# =============================================================================
# qam-ingest.ps1 — Qualys 一覧 XML パーサ
# =============================================================================
# group / host / domain の一覧 XML を正規化レコードへ変換する。
# 構造の正典は docs/QUALYS_XML.md。レコード形:
#   @{ key; name; scalar=@{F=val}; set=@{F=@(...)}; info=@{F=val}; hash }
#   scalar+set が差分対象、info は表示用（差分しない＝スキャン日時等のノイズ除外）。
# =============================================================================

function New-QamRecord { @{ key = ''; name = ''; scalar = @{}; set = @{}; info = @{} } }

# 子要素のテキスト（CDATA も InnerText で取れる）。無ければ ''。
function Get-QamText {
    param($Node, [string]$Name)
    if ($null -eq $Node) { return '' }
    $n = $Node.SelectSingleNode($Name)
    if ($n) { return $n.InnerText.Trim() } else { return '' }
}

# 親直下の同名子要素テキストを配列で。
function Get-QamChildValues {
    param($Parent, [string]$Name)
    if ($null -eq $Parent) { return @() }
    @($Parent.SelectNodes($Name) | ForEach-Object { $_.InnerText.Trim() } | Where-Object { $_ -ne '' })
}

# <LIST><ITEM>..</ITEM></LIST> 形の値を配列で。
function Get-QamListValues {
    param($Node, [string]$ListName, [string]$ItemName)
    $list = $Node.SelectSingleNode($ListName)
    if ($null -eq $list) { return @() }
    Get-QamChildValues $list $ItemName
}

# "a, b, c" 形のカンマ区切りテキストを配列で。
function Get-QamCsvValues {
    param($Node, [string]$Name)
    $t = Get-QamText $Node $Name
    if (-not $t) { return @() }
    @($t -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function ConvertTo-QamEntityName {
    param([System.Xml.XmlDocument]$Doc)
    switch ($Doc.DocumentElement.Name) {
        'ASSET_GROUP_LIST_OUTPUT' { 'group' }
        'HOST_LIST_OUTPUT'        { 'host' }
        'DOMAIN_LIST_OUTPUT'      { 'domain' }
        'DOMAIN_LIST'             { 'domain' }
        default                   { $null }
    }
}

function Read-QamGroupRecord {
    param($Ag)
    $rec = New-QamRecord
    $rec.key = Get-QamText $Ag 'ID'
    $rec.name = Get-QamText $Ag 'TITLE'
    $rec.scalar['TITLE'] = $rec.name
    $rec.scalar['OWNER_ID'] = Get-QamText $Ag 'OWNER_ID'
    $rec.scalar['BUSINESS_IMPACT'] = Get-QamText $Ag 'BUSINESS_IMPACT'
    $rec.info['LAST_UPDATE'] = Get-QamText $Ag 'LAST_UPDATE'
    $ips = @()
    $ipset = $Ag.SelectSingleNode('IP_SET')
    if ($ipset) {
        $ips += @(Get-QamChildValues $ipset 'IP')
        $ips += @(Get-QamChildValues $ipset 'IP_RANGE')
    }
    $rec.set['IPS'] = @($ips | Sort-Object -Unique)
    $rec.set['DNS_LIST'] = @(Get-QamListValues $Ag 'DNS_LIST' 'DNS' | Sort-Object -Unique)
    $rec.set['NETBIOS_LIST'] = @(Get-QamListValues $Ag 'NETBIOS_LIST' 'NETBIOS' | Sort-Object -Unique)
    $rec.set['DOMAIN_LIST'] = @(Get-QamListValues $Ag 'DOMAIN_LIST' 'DOMAIN' | Sort-Object -Unique)
    $rec.set['HOST_IDS'] = @(Get-QamCsvValues $Ag 'HOST_IDS' | Sort-Object -Unique)
    return $rec
}

function Read-QamHostRecord {
    param($H)
    $rec = New-QamRecord
    $rec.key = Get-QamText $H 'ID'
    $fqdn = ''
    $dd = $H.SelectSingleNode('DNS_DATA')
    if ($dd) { $fqdn = Get-QamText $dd 'FQDN' }
    $dns = Get-QamText $H 'DNS'
    $ip = Get-QamText $H 'IP'
    $rec.scalar['IP'] = $ip
    $rec.scalar['FQDN'] = $fqdn
    $rec.scalar['DNS'] = $dns
    $rec.scalar['NETBIOS'] = Get-QamText $H 'NETBIOS'
    $rec.scalar['OS'] = Get-QamText $H 'OS'
    $rec.scalar['TRACKING_METHOD'] = Get-QamText $H 'TRACKING_METHOD'
    $rec.info['LAST_VULN_SCAN_DATETIME'] = Get-QamText $H 'LAST_VULN_SCAN_DATETIME'
    $rec.info['FIRST_FOUND_DATE'] = Get-QamText $H 'FIRST_FOUND_DATE'
    $rec.name = if ($fqdn) { $fqdn } elseif ($dns) { $dns } else { $ip }
    return $rec
}

function Read-QamDomainRecord {
    param($D)
    $rec = New-QamRecord
    $name = Get-QamText $D 'DOMAIN_NAME'
    if (-not $name -and $D.SelectNodes('*').Count -eq 0) { $name = $D.InnerText.Trim() }
    $rec.key = $name
    $rec.name = $name
    $rec.scalar['DOMAIN_ID'] = Get-QamText $D 'DOMAIN_ID'
    $net = $D.SelectSingleNode('NETWORK')
    $rec.scalar['NETWORK_NAME'] = if ($net) { Get-QamText $net 'NETWORK_NAME' } else { '' }
    $blocks = @()
    $nb = $D.SelectSingleNode('NETBLOCK')
    if ($nb) {
        foreach ($r in $nb.SelectNodes('RANGE')) {
            $s = Get-QamText $r 'START'; $e = Get-QamText $r 'END'
            if ($s -or $e) { $blocks += "$s-$e" }
        }
    }
    $rec.set['NETBLOCK'] = @($blocks | Sort-Object -Unique)
    return $rec
}

# scalar + set の正規形から安定ハッシュ（変更検知用）。
function Get-QamRecordHash {
    param($Rec)
    $sb = New-Object System.Text.StringBuilder
    foreach ($k in ($Rec.scalar.Keys | Sort-Object)) { [void]$sb.Append("$k=$($Rec.scalar[$k])|") }
    foreach ($k in ($Rec.set.Keys | Sort-Object)) {
        $vals = (@($Rec.set[$k]) | Sort-Object) -join ','
        [void]$sb.Append("$k=[$vals]|")
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
    $sha = [System.Security.Cryptography.SHA1]::Create()
    return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
}

# XML ファイル → @{ entity; records=@{key=record} }。Entity 未指定ならルートから判定。
function ConvertFrom-QamXml {
    param([Parameter(Mandatory)][string]$Path, [string]$Entity)
    [xml]$doc = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if (-not $Entity) { $Entity = ConvertTo-QamEntityName $doc }
    if (-not $Entity) { throw "未知の XML ルート要素です: $($doc.DocumentElement.Name)" }
    $records = @{}
    switch ($Entity) {
        'group'  { foreach ($n in $doc.SelectNodes('//ASSET_GROUP')) { $r = Read-QamGroupRecord $n; $r.hash = Get-QamRecordHash $r; $records[$r.key] = $r } }
        'host'   { foreach ($n in $doc.SelectNodes('//HOST'))        { $r = Read-QamHostRecord $n;  $r.hash = Get-QamRecordHash $r; $records[$r.key] = $r } }
        'domain' { foreach ($n in $doc.SelectNodes('//DOMAIN'))      { $r = Read-QamDomainRecord $n; if ($r.key) { $r.hash = Get-QamRecordHash $r; $records[$r.key] = $r } } }
    }
    $dt = ''
    $dtNode = $doc.SelectSingleNode('//DATETIME')
    if ($dtNode) { $dt = $dtNode.InnerText.Trim() }
    return [pscustomobject]@{ entity = $Entity; datetime = $dt; records = $records }
}

# XML の RESPONSE/DATETIME（あれば）を yyyy-MM-dd へ。無ければ本日。
function Resolve-QamSnapshotDate {
    param([string]$Datetime)
    if ($Datetime) {
        try { return ([datetime]$Datetime).ToString('yyyy-MM-dd') } catch { }
    }
    return (Get-Date).ToString('yyyy-MM-dd')
}
