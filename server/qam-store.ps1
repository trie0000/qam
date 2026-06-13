# =============================================================================
# qam-store.ps1 — データ IO 層
# =============================================================================
# snapshots / history / comments / runs の読み書き・剪定・asof 解決。
# DB は使わずファイル（JSON / JSONL）。Windows PowerShell 5.1 / PowerShell 7 両対応
# （-AsHashtable は 5.1 に無いので使わず、自前で再帰変換する）。
# =============================================================================

# PSCustomObject / 配列を再帰的に hashtable / array へ（JSON 読戻し用、5.1 互換）。
function ConvertTo-QamHashtable {
    param($Obj)
    if ($null -eq $Obj) { return $null }
    if ($Obj -is [string]) { return $Obj }
    if ($Obj -is [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($k in $Obj.Keys) { $h[[string]$k] = ConvertTo-QamHashtable $Obj[$k] }
        return $h
    }
    if ($Obj -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $Obj.PSObject.Properties) { $h[$p.Name] = ConvertTo-QamHashtable $p.Value }
        return $h
    }
    if ($Obj -is [System.Collections.IEnumerable]) {
        $a = @()
        foreach ($i in $Obj) { $a += ,(ConvertTo-QamHashtable $i) }
        return ,$a
    }
    return $Obj
}

function Get-QamPaths {
    param([Parameter(Mandatory)][string]$DataDir)
    [pscustomobject]@{
        Root      = $DataDir
        Snapshots = Join-Path $DataDir 'snapshots'
        History   = Join-Path $DataDir 'history'
        Comments  = Join-Path $DataDir 'comments'
        Raw       = Join-Path $DataDir 'raw'
        Runs      = Join-Path $DataDir 'runs.jsonl'
    }
}

function Initialize-QamStore {
    param([Parameter(Mandatory)][string]$DataDir)
    $p = Get-QamPaths $DataDir
    foreach ($d in @($p.Snapshots, $p.History, $p.Comments, $p.Raw)) {
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    foreach ($e in @('group', 'host', 'domain')) {
        $sd = Join-Path $p.Snapshots $e
        if (-not (Test-Path -LiteralPath $sd)) { New-Item -ItemType Directory -Path $sd -Force | Out-Null }
    }
    return $p
}

# --- snapshots ---------------------------------------------------------------

function Get-QamSnapshotDates {
    param([string]$DataDir, [string]$Entity)
    $dir = Join-Path (Join-Path $DataDir 'snapshots') $Entity
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.BaseName } | Sort-Object)
}

# 指定日以前で最大日付（asof 未指定なら最新）。該当無しは $null。
function Resolve-QamAsofDate {
    param([string]$DataDir, [string]$Entity, [string]$Asof)
    $dates = @(Get-QamSnapshotDates -DataDir $DataDir -Entity $Entity)
    if ($dates.Count -eq 0) { return $null }
    if (-not $Asof) { return $dates[-1] }
    $le = @($dates | Where-Object { $_ -le $Asof })
    if ($le.Count -gt 0) { return $le[-1] } else { return $null }
}

function Read-QamSnapshot {
    param([string]$DataDir, [string]$Entity, [string]$Date)
    $f = Join-Path (Join-Path (Join-Path $DataDir 'snapshots') $Entity) "$Date.json"
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    $obj = (Get-Content -LiteralPath $f -Raw -Encoding UTF8) | ConvertFrom-Json
    return (ConvertTo-QamHashtable $obj)
}

function Write-QamSnapshot {
    param([string]$DataDir, [string]$Entity, [string]$Date, $Snapshot)
    $f = Join-Path (Join-Path (Join-Path $DataDir 'snapshots') $Entity) "$Date.json"
    ($Snapshot | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $f -Encoding UTF8
}

# --- history -----------------------------------------------------------------

function Add-QamHistory {
    param([string]$DataDir, [string]$Entity, [object[]]$Events)
    if (-not $Events -or $Events.Count -eq 0) { return }
    $f = Join-Path (Join-Path $DataDir 'history') "$Entity.jsonl"
    $lines = foreach ($e in $Events) { $e | ConvertTo-Json -Depth 8 -Compress }
    Add-Content -LiteralPath $f -Value $lines -Encoding UTF8
}

function Read-QamHistory {
    param([string]$DataDir, [string]$Entity, [string]$From, [string]$To)
    $f = Join-Path (Join-Path $DataDir 'history') "$Entity.jsonl"
    if (-not (Test-Path -LiteralPath $f)) { return @() }
    $out = @()
    foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8)) {
        if (-not $line.Trim()) { continue }
        $e = $line | ConvertFrom-Json
        if ($From -and $e.ts -lt $From) { continue }
        if ($To -and $e.ts -gt $To) { continue }
        $out += $e
    }
    return $out
}

# --- comments（資産単位の作業履歴） -----------------------------------------

function Add-QamComment {
    param([string]$DataDir, [string]$Entity, [string]$Id, [string]$Author, [string]$Text, [string]$Ts)
    $f = Join-Path (Join-Path $DataDir 'comments') 'comments.jsonl'
    $rec = [ordered]@{ ts = $Ts; entity = $Entity; id = $Id; author = $Author; text = $Text }
    Add-Content -LiteralPath $f -Value ($rec | ConvertTo-Json -Compress) -Encoding UTF8
}

function Read-QamComments {
    param([string]$DataDir, [string]$Entity, [string]$Id)
    $f = Join-Path (Join-Path $DataDir 'comments') 'comments.jsonl'
    if (-not (Test-Path -LiteralPath $f)) { return @() }
    $out = @()
    foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8)) {
        if (-not $line.Trim()) { continue }
        $c = $line | ConvertFrom-Json
        if ($Entity -and $c.entity -ne $Entity) { continue }
        if ($Id -and $c.id -ne $Id) { continue }
        $out += $c
    }
    return $out
}

# --- runs / prune ------------------------------------------------------------

function Add-QamRun {
    param([string]$DataDir, $Run)
    Add-Content -LiteralPath (Join-Path $DataDir 'runs.jsonl') -Value ($Run | ConvertTo-Json -Compress) -Encoding UTF8
}

# 保存期間超過の snapshots/*/<date>.json と raw/<date> を剪定（history/comments は対象外）。
function Invoke-QamPrune {
    param([string]$DataDir, [int]$RetentionDays, [datetime]$RefDate)
    if ($RetentionDays -le 0) { return @() }
    $cutoff = $RefDate.Date.AddDays(-$RetentionDays)
    $removed = @()
    foreach ($e in @('group', 'host', 'domain')) {
        $dir = Join-Path (Join-Path $DataDir 'snapshots') $e
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter '*.json' -ErrorAction SilentlyContinue)) {
            $d = [datetime]::MinValue
            if ([datetime]::TryParse($f.BaseName, [ref]$d) -and $d.Date -lt $cutoff) {
                Remove-Item -LiteralPath $f.FullName -Force
                $removed += "$e/$($f.BaseName)"
            }
        }
    }
    $rawRoot = Join-Path $DataDir 'raw'
    if (Test-Path -LiteralPath $rawRoot) {
        foreach ($rd in (Get-ChildItem -LiteralPath $rawRoot -Directory -ErrorAction SilentlyContinue)) {
            $d = [datetime]::MinValue
            if ([datetime]::TryParse($rd.Name, [ref]$d) -and $d.Date -lt $cutoff) {
                Remove-Item -LiteralPath $rd.FullName -Recurse -Force
                $removed += "raw/$($rd.Name)"
            }
        }
    }
    return $removed
}
