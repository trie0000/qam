# =============================================================================
# qam-pipeline.ps1 — 取り込みオーケストレーション
# =============================================================================
# XML ファイル 1 つ → パース → 直前スナップショットと差分 → 保存（冪等）。
# 件数急減ガードに掛かり -Force 未指定なら commit せず結果だけ返す（呼び出し側で
# ステージ→確認→-Force 再実行）。store / ingest / diff を前提に dot-source される。
# =============================================================================

function Measure-QamChange {
    param($Events, [string]$Change)
    # $null/@() が引数で $null 化された場合に Where-Object が一度 $_=$null で回る対策。
    @($Events | Where-Object { $null -ne $_ -and $_.change -eq $Change }).Count
}

# 指定日より前で最大のスナップショット日付（差分の相手）。
function Get-QamPrevDate {
    param([string]$DataDir, [string]$Entity, [string]$Date)
    $lt = @(Get-QamSnapshotDates -DataDir $DataDir -Entity $Entity | Where-Object { $_ -lt $Date })
    if ($lt.Count -gt 0) { return $lt[-1] } else { return $null }
}

function Invoke-QamIngest {
    param(
        [Parameter(Mandatory)][string]$DataDir,
        [Parameter(Mandatory)][string]$XmlPath,
        [string]$Entity,
        [string]$Date,
        [double]$GuardRatio = 0.5,
        [int]$RetentionDays = 90,
        [switch]$Force
    )
    $parsed = ConvertFrom-QamXml -Path $XmlPath -Entity $Entity
    $entity = $parsed.entity
    if (-not $Date) { $Date = Resolve-QamSnapshotDate $parsed.datetime }

    $currCount = $parsed.records.Count
    $prevDate = Get-QamPrevDate -DataDir $DataDir -Entity $entity -Date $Date
    $prev = $null; $prevCount = 0
    if ($prevDate) {
        $prev = (Read-QamSnapshot -DataDir $DataDir -Entity $entity -Date $prevDate).records
        $prevCount = @($prev.Keys).Count
    }

    $baseline = (-not $prevDate)
    $guard = Test-QamShrinkGuard -PrevCount $prevCount -CurrCount $currCount -Ratio $GuardRatio
    $res = [ordered]@{
        entity = $entity; date = $Date; prevCount = $prevCount; currCount = $currCount
        baseline = $baseline; guard = $guard; committed = $false; added = 0; modified = 0; deleted = 0; pruned = 0
    }
    if ($guard -and -not $Force) { return $res }

    # --- commit ---
    Write-QamSnapshot -DataDir $DataDir -Entity $entity -Date $Date -Snapshot @{
        date = $Date; entity = $entity; records = $parsed.records
    }
    # 初回（baseline）は現状確立のみ。全件を added として記録すると初日が洪水になるため履歴は出さない。
    $events = if ($baseline) { @() } else { @(Compare-QamSnapshots -Prev $prev -Curr $parsed.records -Entity $entity -Date $Date) }
    Remove-QamHistoryForDate -DataDir $DataDir -Entity $entity -Date $Date  # 冪等な再取込
    Add-QamHistory -DataDir $DataDir -Entity $entity -Events $events
    $res.added = Measure-QamChange $events 'added'
    $res.modified = Measure-QamChange $events 'modified'
    $res.deleted = Measure-QamChange $events 'deleted'
    Add-QamRun -DataDir $DataDir -Run ([ordered]@{
        ts = $Date; entity = $entity; count = $currCount
        added = $res.added; modified = $res.modified; deleted = $res.deleted; completed = $true
    })
    Save-QamRaw -DataDir $DataDir -Entity $entity -Date $Date -SrcPath $XmlPath
    $res.pruned = @(Invoke-QamPrune -DataDir $DataDir -RetentionDays $RetentionDays -RefDate (Get-Date)).Count
    $res.committed = $true
    return $res
}
