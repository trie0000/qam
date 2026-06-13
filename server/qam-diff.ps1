# =============================================================================
# qam-diff.ps1 — 差分エンジン
# =============================================================================
# 前回スナップショット（records: key->record）と今回を比較し、改廃イベントを生成。
#   added / deleted          … 資産そのものの追加・削除（field なし）
#   modified (scalar)        … old / new
#   modified (set: IPS等)    … added / removed（メンバ増減）
# =============================================================================

function New-QamEvent {
    param([string]$Entity, [string]$Id, [string]$Name, [string]$Change, [string]$Date)
    [ordered]@{
        eid = "$Entity`:$Id`:$Date`:_"; ts = $Date; entity = $Entity
        id = $Id; name = $Name; change = $Change
    }
}

# $null / '' を除いた配列に正規化（JSON 読戻しで単一要素や null が混じる対策）。
function ConvertTo-QamCleanArray {
    param($Value)
    @(@($Value) | Where-Object { $null -ne $_ -and "$_" -ne '' })
}

# modified の中身（scalar old/new と set added/removed）を列挙。
function Get-QamFieldDiffs {
    param([string]$Entity, [string]$Id, [string]$Name, $P, $C, [string]$Date)
    $evts = @()
    $skeys = @(@($P.scalar.Keys) + @($C.scalar.Keys) | Sort-Object -Unique)
    foreach ($f in $skeys) {
        $ov = if ($P.scalar.ContainsKey($f)) { "$($P.scalar[$f])" } else { '' }
        $nv = if ($C.scalar.ContainsKey($f)) { "$($C.scalar[$f])" } else { '' }
        if ($ov -ne $nv) {
            $evts += [ordered]@{
                eid = "$Entity`:$Id`:$Date`:$f"; ts = $Date; entity = $Entity; id = $Id
                name = $Name; change = 'modified'; field = $f; old = $ov; new = $nv
            }
        }
    }
    $tkeys = @(@($P.set.Keys) + @($C.set.Keys) | Sort-Object -Unique)
    foreach ($f in $tkeys) {
        $ov = ConvertTo-QamCleanArray $(if ($P.set.ContainsKey($f)) { $P.set[$f] })
        $nv = ConvertTo-QamCleanArray $(if ($C.set.ContainsKey($f)) { $C.set[$f] })
        $added = @($nv | Where-Object { $_ -notin $ov })
        $removed = @($ov | Where-Object { $_ -notin $nv })
        if ($added.Count -gt 0 -or $removed.Count -gt 0) {
            $evts += [ordered]@{
                eid = "$Entity`:$Id`:$Date`:$f"; ts = $Date; entity = $Entity; id = $Id
                name = $Name; change = 'modified'; field = $f; added = $added; removed = $removed
            }
        }
    }
    return $evts
}

# Prev/Curr: hashtable key->record（$null 可）。Date は取込日（イベントの ts）。
function Compare-QamSnapshots {
    param($Prev, $Curr, [string]$Entity, [string]$Date)
    $events = @()
    $prevKeys = if ($Prev) { @($Prev.Keys) } else { @() }
    $currKeys = if ($Curr) { @($Curr.Keys) } else { @() }
    foreach ($k in $currKeys) {
        if (-not $Prev -or -not $Prev.ContainsKey($k)) {
            $events += (New-QamEvent $Entity $k $Curr[$k].name 'added' $Date)
        }
    }
    foreach ($k in $prevKeys) {
        if (-not $Curr -or -not $Curr.ContainsKey($k)) {
            $events += (New-QamEvent $Entity $k $Prev[$k].name 'deleted' $Date)
        }
    }
    foreach ($k in $currKeys) {
        if ($Prev -and $Prev.ContainsKey($k)) {
            $p = $Prev[$k]; $c = $Curr[$k]
            if ($p.hash -ne $c.hash) {
                $events += (Get-QamFieldDiffs $Entity $k $c.name $p $c $Date)
            }
        }
    }
    return $events
}

# 件数急減ガード: 前回比で Ratio 以上に減った（または 0 件）なら $true（確定前に要確認）。
function Test-QamShrinkGuard {
    param([int]$PrevCount, [int]$CurrCount, [double]$Ratio)
    if ($PrevCount -le 0) { return $false }
    if ($CurrCount -le 0) { return $true }
    $drop = ($PrevCount - $CurrCount) / [double]$PrevCount
    return ($drop -ge $Ratio)
}
