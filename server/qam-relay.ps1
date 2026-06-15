# =============================================================================
# qam-relay.ps1 — 薄いローカル中継（Windows PowerShell 5.1 / PowerShell 7 両対応）
# =============================================================================
# ブラウザ(TS アプリ)が出来ないことだけを担う:
#   1) TS バンドル(dist/qam.bundle.js)の配信
#   2) Qualys API を「プロキシ経由 + Basic 認証」で取得（CORS/プロキシ回避）
#   3) UNC データディレクトリ配下のファイル read/write/list/remove
# パース/差分/ストレージ書式の解釈は全て TS 側。relay はパス安全性だけ担保する。
# 127.0.0.1 で listen するので管理者権限不要。設定は 引数 > 環境変数 > qam.env。
#   実行: powershell -ExecutionPolicy Bypass -File qam-relay.ps1   （通常は qam-start.bat 経由）
# =============================================================================
[CmdletBinding()]
param(
    [int]$Port,
    [string]$DataDir,
    [string]$BundleDir,
    [string]$EnvFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http | Out-Null

# ─── env 読込/保存 ───────────────────────────────────────────────────────────
function Import-QamEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('='); if ($eq -lt 1) { continue }
        $k = $line.Substring(0, $eq).Trim(); $v = $line.Substring($eq + 1).Trim()
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        if (-not [Environment]::GetEnvironmentVariable($k)) { [Environment]::SetEnvironmentVariable($k, $v) }
    }
}
function Set-QamEnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = @(); if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*#?\s*$([regex]::Escape($Key))\s*=") { $lines[$i] = "$Key=$Value"; $found = $true; break }
    }
    if (-not $found) { $lines += "$Key=$Value" }
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot 'qam.env' }
Import-QamEnv $EnvFile
if (-not $DataDir) { $DataDir = $env:QAM_DATA_DIR }
if (-not $DataDir) { Write-Host '[qam] QAM_DATA_DIR が未設定です。qam.env を設定してください。' -ForegroundColor Red; exit 2 }
if (-not $Port) { $Port = if ($env:QAM_RELAY_PORT) { [int]$env:QAM_RELAY_PORT } else { 18090 } }
if (-not $BundleDir) { $BundleDir = if ($env:QAM_BUNDLE_DIR) { $env:QAM_BUNDLE_DIR } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'dist' } }
if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
$DataFull = (Resolve-Path -LiteralPath $DataDir).Path
$script:LogFile = Join-Path $DataFull 'relay.log'
$script:QamStop = $false
# Qualys セッション（login で取得し fetch で使い回し、logout で破棄）。
$script:QSession = $null; $script:QProxy = $null; $script:QBase = $null

# ─── HTTP ヘルパ ─────────────────────────────────────────────────────────────
function Set-Cors { param($Resp)
    $Resp.Headers['Access-Control-Allow-Origin'] = '*'
    $Resp.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $Resp.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
    # バンドルを含め一切キャッシュさせない（古い JS を掴み続けて修正が反映されないのを防ぐ）。
    $Resp.Headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
}

# コンソールに出しつつ relay.log にも追記（コンソールを見れない時の証跡）。
function Add-QamLog { param([string]$Text)
    try { Add-Content -LiteralPath $script:LogFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) -Encoding UTF8 } catch { }
}
function Send-Bytes { param($Ctx, [byte[]]$Bytes, [string]$Type, [int]$Status = 200)
    $r = $Ctx.Response; Set-Cors $r; $r.StatusCode = $Status; $r.ContentType = $Type
    $r.ContentLength64 = $Bytes.Length; $r.OutputStream.Write($Bytes, 0, $Bytes.Length); $r.OutputStream.Close()
}
function Send-Text { param($Ctx, [string]$Text, [string]$Type = 'text/plain; charset=utf-8', [int]$Status = 200)
    Send-Bytes $Ctx ([Text.Encoding]::UTF8.GetBytes($Text)) $Type $Status
}
function Send-Json { param($Ctx, $Obj, [int]$Status = 200)
    Send-Text $Ctx ($Obj | ConvertTo-Json -Depth 12) 'application/json; charset=utf-8' $Status
}
function Get-Body { param($Req)
    if (-not $Req.HasEntityBody) { return '' }
    # 必ず UTF-8 で読む。$Req.ContentEncoding は charset 未指定だと日本語 Windows で
    # CP932 になり、UTF-8 の JSON ボディが文字化け→ConvertFrom-Json が壊れる。
    $sr = New-Object System.IO.StreamReader($Req.InputStream, [System.Text.Encoding]::UTF8)
    try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
}
# path を DataDir 配下に閉じ込めて解決（.. 等での脱出を拒否）。
function Resolve-SafePath { param([string]$Rel)
    if (-not $Rel) { throw 'path 未指定' }
    $full = [IO.Path]::GetFullPath((Join-Path $DataFull $Rel))
    if (-not $full.StartsWith($DataFull, [StringComparison]::Ordinal)) { throw "範囲外 path: $Rel" }
    return $full
}

# ─── Qualys プロキシ取得 ─────────────────────────────────────────────────────
function Get-QamText1 { param([string]$Xml, [string]$Pattern)
    $m = [regex]::Match($Xml, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($m.Success) { return ($m.Groups[1].Value -replace '<!\[CDATA\[', '' -replace '\]\]>', '').Trim() }
    return $null
}

# Qualys API を GET。セッション確立中は Cookie、未確立なら Basic 認証（後方互換）。
function Invoke-QualysFetch { param($Body)
    # user 一覧は QPS RBAC API(POST /qps/rest/2.0/search/am/user/) を Basic 認証で叩く。
    # （/api/2.0/fo/user/ は存在せず、/msp/user_list.php は VMDR で無効のため。公式: docs.qualys.com admin/api）
    $isUserList = (-not $Body.url) -and ($Body.kind -eq 'user')
    # noSession 指定時は Basic 認証で叩く（401/403 再試行用）。user(QPS) も Basic 固定。
    $useSession = $script:QSession -and -not $Body.noSession -and -not $isUserList
    # プロキシは本文指定を優先（session 経路でも確実にプロキシを通す。proxy=なしで直結する不具合対策）。
    $proxy = if ($Body.proxy) { $Body.proxy } elseif ($script:QProxy) { $script:QProxy } else { $null }
    $base = if ($Body.base) { ([string]$Body.base).TrimEnd('/') } elseif ($script:QBase) { $script:QBase } else { '' }
    $url = $Body.url
    if (-not $url) {
        switch ($Body.kind) {
            'group'  { $url = "$base/api/2.0/fo/asset/group/?action=list&show_attributes=ALL" }
            # host は v2 が EOS（EOL予告）。v5.0 に切替（同じ action=list/details=All、HOST_LIST_OUTPUT、
            # WARNING/URL ページング。次ページURLは応答が返すものに従うので自動で 5.0 になる）。
            'host'   { $url = "$base/api/5.0/fo/asset/host/?action=list&details=All&truncation_limit=1000" }
            'domain' { $url = "$base/api/2.0/fo/asset/domain/?action=list" }
            # IPs in Subscription（サブスクリプションに登録された IP / IP_RANGE）。件数算出用。
            'ips'    { $url = "$base/api/2.0/fo/asset/ip/?action=list" }
            # user 一覧は QPS RBAC: POST /qps/rest/2.0/search/am/user/（末尾スラッシュ必須）。
            # 応答 ServiceResponse(XML)。role/scopeTags を含む。Active ユーザのみ返る。
            'user'   { $url = "$base/qps/rest/2.0/search/am/user/" }
            default  { throw "未知 kind: $($Body.kind)" }
        }
    }
    $handler = New-Object System.Net.Http.HttpClientHandler
    # UseCookies=true(既定)だとハンドラが Cookie を自前管理し、手で付けた Cookie ヘッダが送られない
    # （login 200 でCookieを取れても fetch で QualysSession が送信されず 401 になる原因）。false にする。
    $handler.UseCookies = $false
    if ($proxy) { $handler.Proxy = New-Object System.Net.WebProxy($proxy); $handler.UseProxy = $true }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(60)  # ハングで relay 全体が止まらないように
    try {
        # User-Agent を必ず付与（無いと WAF が空応答/403 を返すことがある＝curl との差分の正体）。
        $client.DefaultRequestHeaders.Add('User-Agent', 'curl/8.4.0')
        $client.DefaultRequestHeaders.Add('X-Requested-With', 'QAM')  # FO v2 API で必須
        if ($useSession) {
            $client.DefaultRequestHeaders.Add('Cookie', "QualysSession=$($script:QSession)")
        } elseif ($Body.user) {
            $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($Body.user):$($Body.pass)"))
            $client.DefaultRequestHeaders.Add('Authorization', "Basic $b64")
        }
        $method = if ($isUserList) { 'POST' } else { 'GET' }
        Write-Host "[qam] fetch $method $url (session=$useSession, proxy=$(if ($proxy) { $proxy } else { 'なし' }))" -ForegroundColor DarkCyan
        Add-QamLog "FETCH start $method $url (session=$useSession, proxy=$(if ($proxy) { $proxy } else { 'none' }))"
        if ($isUserList) {
            # QPS REST はページング（既定100件/ページ。hasMoreRecords/lastId で続き）。
            # 全ページを POST で辿り、<User> 要素を結合して 1 つの ServiceResponse にする。
            $sb = New-Object System.Text.StringBuilder
            $lastId = ''; $page = 0; $ok = $true; $more = $false
            do {
                $page++
                $crit = if ($lastId) { "<filters><Criteria field=`"id`" operator=`"GREATER`">$lastId</Criteria></filters>" } else { '' }
                $bodyXml = "<ServiceRequest><preferences><limitResults>1000</limitResults></preferences>$crit</ServiceRequest>"
                $resp = $client.PostAsync($url, (New-Object System.Net.Http.StringContent($bodyXml, [Text.Encoding]::UTF8, 'application/xml'))).Result
                $reason = [string]$resp.ReasonPhrase
                $ctype = if ($resp.Content -and $resp.Content.Headers.ContentType) { [string]$resp.Content.Headers.ContentType } else { '' }
                $pageBytes = if ($resp.Content) { $resp.Content.ReadAsByteArrayAsync().Result } else { [byte[]]@() }
                $pageXml = if ($pageBytes.Length) { [System.Text.Encoding]::UTF8.GetString($pageBytes) } else { '' }
                if (-not $resp.IsSuccessStatusCode) { $ok = $false; $sb = New-Object System.Text.StringBuilder; [void]$sb.Append($pageXml); break }
                foreach ($m in [regex]::Matches($pageXml, '(?s)<User>.*?</User>')) { [void]$sb.Append($m.Value) }
                $more = ($pageXml -match '<hasMoreRecords>\s*true\s*</hasMoreRecords>')
                $lm = [regex]::Match($pageXml, '<lastId>\s*(\d+)\s*</lastId>')
                $lastId = if ($lm.Success) { $lm.Groups[1].Value } else { '' }
                Add-QamLog "FETCH user page ${page}: more=$more lastId=$lastId"
            } while ($ok -and $more -and $lastId -and $page -lt 200)
            $xml = if ($ok) { "<?xml version=`"1.0`" encoding=`"UTF-8`"?><ServiceResponse><responseCode>SUCCESS</responseCode><data>$($sb.ToString())</data></ServiceResponse>" } else { $sb.ToString() }
            $next = $null
        } else {
            $resp = $client.GetAsync($url).Result
            # UTF-8 固定でデコード（charset ヘッダ依存で化けるのを防ぐ。Qualys 出力は UTF-8）。
            # Content が null になり得る応答（リダイレクト/本文無し 401 等）でも落ちないようガードする。
            $content = $resp.Content
            $bytes = if ($content) { $content.ReadAsByteArrayAsync().Result } else { [byte[]]@() }
            $xml = if ($bytes.Length) { [System.Text.Encoding]::UTF8.GetString($bytes) } else { '' }
            $next = Get-QamText1 $xml '<URL><!\[CDATA\[(.*?)\]\]></URL>'
            $ok = $resp.IsSuccessStatusCode
            $reason = [string]$resp.ReasonPhrase
            $ctype = if ($content -and $content.Headers.ContentType) { [string]$content.Headers.ContentType } else { '' }
        }
        # 応答本文のスニペット（空白畳み込み）。成功は短め、失敗は理由が分かるよう長めに残す。
        $snippet = ($xml -replace '\s+', ' ').Trim()
        $cap = if ($ok) { 300 } else { 1500 }
        if ($snippet.Length -gt $cap) { $snippet = $snippet.Substring(0, $cap) + ' …(truncated)' }
        $color = if ($ok) { 'DarkCyan' } else { 'Yellow' }
        Write-Host "[qam] fetch -> HTTP $([int]$resp.StatusCode) $reason, $($xml.Length) chars, ctype=$ctype, nextPage=$([bool]$next)" -ForegroundColor $color
        Write-Host "[qam] fetch body: $snippet" -ForegroundColor $color
        Add-QamLog "FETCH done HTTP $([int]$resp.StatusCode) $reason, $($xml.Length) chars, ctype=$ctype, nextPage=$([bool]$next)"
        Add-QamLog "FETCH body: $snippet"
        return [ordered]@{ ok = $ok; status = [int]$resp.StatusCode; nextUrl = $next; xml = $xml }
    } finally { $client.Dispose(); $handler.Dispose() }
}

# session login: Cookie(QualysSession) を取得して保持。
function Invoke-QualysLogin { param($Body)
    $base = ([string]$Body.base).TrimEnd('/')
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.CookieContainer = New-Object System.Net.CookieContainer
    if ($Body.proxy) { $handler.Proxy = New-Object System.Net.WebProxy($Body.proxy); $handler.UseProxy = $true }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(60)  # ハングで relay 全体が止まらないように
    try {
        $client.DefaultRequestHeaders.Add('X-Requested-With', 'QAM')
        $form = "action=login&username=$([Uri]::EscapeDataString([string]$Body.user))&password=$([Uri]::EscapeDataString([string]$Body.pass))"
        $content = New-Object System.Net.Http.StringContent($form, [Text.Encoding]::UTF8, 'application/x-www-form-urlencoded')
        Write-Host "[qam] login POST $base/api/2.0/fo/session/ (user=$($Body.user), proxy=$(if ($Body.proxy) { $Body.proxy } else { 'なし' }))" -ForegroundColor Cyan
        Add-QamLog "LOGIN start $base (user=$($Body.user), proxy=$(if ($Body.proxy) { $Body.proxy } else { 'none' }))"
        # セッション API のエンドポイントは /api/2.0/fo/session/（action は body の action=login）。
        # 末尾に login/ を付けると 404 になる（毎回ログイン失敗の原因）。
        $resp = $client.PostAsync("$base/api/2.0/fo/session/", $content).Result
        $body = $resp.Content.ReadAsStringAsync().Result
        # Cookie は Set-Cookie ヘッダから直接拾う（CookieContainer に入らない環境対策）。
        $cookieVal = $null
        $setc = $null
        if ($resp.Headers.TryGetValues('Set-Cookie', [ref]$setc)) {
            foreach ($sc in $setc) { $mm = [regex]::Match($sc, 'QualysSession=([^;]+)'); if ($mm.Success) { $cookieVal = $mm.Groups[1].Value } }
        }
        if (-not $cookieVal) {
            foreach ($c in $handler.CookieContainer.GetCookies((New-Object System.Uri($base)))) { if ($c.Name -eq 'QualysSession') { $cookieVal = $c.Value } }
        }
        $logBody = ($body -replace '\s+', ' ').Trim(); if ($logBody.Length -gt 500) { $logBody = $logBody.Substring(0, 500) + ' …(truncated)' }
        Write-Host "[qam] login -> HTTP $([int]$resp.StatusCode) $([string]$resp.ReasonPhrase), cookie=$([bool]$cookieVal)" -ForegroundColor Cyan
        Add-QamLog "LOGIN done HTTP $([int]$resp.StatusCode) $([string]$resp.ReasonPhrase), cookie=$([bool]$cookieVal)"
        Add-QamLog "LOGIN body: $logBody"
        if ($resp.IsSuccessStatusCode -and $cookieVal) {
            $script:QSession = $cookieVal; $script:QProxy = $Body.proxy; $script:QBase = $base
            return [ordered]@{ ok = $true; status = [int]$resp.StatusCode }
        }
        $snippet = ($body -replace '\s+', ' ').Trim()
        if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) }
        $err = Get-QamText1 $body '<TEXT>(.*?)</TEXT>'
        if (-not $err) { $err = "HTTP $([int]$resp.StatusCode): $snippet" }
        return [ordered]@{ ok = $false; status = [int]$resp.StatusCode; cookieSeen = [bool]$cookieVal; error = $err }
    } catch {
        return [ordered]@{ ok = $false; error = "接続エラー: $($_.Exception.Message)" }
    } finally { $client.Dispose(); $handler.Dispose() }
}

# session logout: 保持中のセッションを破棄（取得後は必ず呼ぶ）。
function Invoke-QualysLogout {
    if (-not $script:QSession) { return [ordered]@{ ok = $true; note = 'no session' } }
    $handler = New-Object System.Net.Http.HttpClientHandler
    if ($script:QProxy) { $handler.Proxy = New-Object System.Net.WebProxy($script:QProxy); $handler.UseProxy = $true }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(60)  # ハングで relay 全体が止まらないように
    try {
        $client.DefaultRequestHeaders.Add('X-Requested-With', 'QAM')
        $client.DefaultRequestHeaders.Add('Cookie', "QualysSession=$($script:QSession)")
        $content = New-Object System.Net.Http.StringContent('action=logout', [Text.Encoding]::UTF8, 'application/x-www-form-urlencoded')
        $resp = $client.PostAsync("$($script:QBase)/api/2.0/fo/session/", $content).Result
        return [ordered]@{ ok = $resp.IsSuccessStatusCode; status = [int]$resp.StatusCode }
    } catch { return [ordered]@{ ok = $false; error = $_.Exception.Message } }
    finally { $client.Dispose(); $handler.Dispose(); $script:QSession = $null; $script:QProxy = $null; $script:QBase = $null }
}

# ─── ルーティング ────────────────────────────────────────────────────────────
$IndexHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QAM — Qualys Asset Management</title></head><body><div id="qam-root"></div><script src="/qam/bundle/qam.bundle.js"></script></body></html>'

function Invoke-Route { param($Ctx)
    $req = $Ctx.Request
    $path = $req.Url.AbsolutePath
    $reqLine = "{0} {1}" -f $req.HttpMethod, $path
    Write-Host ("[qam] " + (Get-Date -Format 'HH:mm:ss') + " " + $reqLine) -ForegroundColor DarkGray
    Add-QamLog "REQ $reqLine"
    if ($req.HttpMethod -eq 'OPTIONS') { Send-Bytes $Ctx ([byte[]]@()) 'text/plain' 204; return }
    $q = $req.QueryString

    switch -Regex ($path) {
        '^/qam/health$' { Send-Json $Ctx @{ ok = $true; version = '0.1.0-phase1' }; return }
        '^/$' { Send-Text $Ctx $IndexHtml 'text/html; charset=utf-8'; return }
        '^/qam/bundle/(.+)$' {
            $f = Join-Path $BundleDir $Matches[1]
            if (-not (Test-Path -LiteralPath $f)) { Send-Json $Ctx @{ error = 'bundle not built'; hint = 'npm run build' } 404; return }
            $ct = if ($f -match '\.js$') { 'text/javascript; charset=utf-8' } else { 'text/plain; charset=utf-8' }
            Send-Bytes $Ctx ([IO.File]::ReadAllBytes($f)) $ct; return
        }
        '^/qam/qualys/login$' {
            try { Send-Json $Ctx (Invoke-QualysLogin (Get-Body $req | ConvertFrom-Json)) }
            catch { Send-Json $Ctx @{ ok = $false; error = $_.Exception.Message } 502 }
            return
        }
        '^/qam/qualys/logout$' {
            try { Send-Json $Ctx (Invoke-QualysLogout) }
            catch { Send-Json $Ctx @{ ok = $false; error = $_.Exception.Message } 502 }
            return
        }
        '^/qam/fetch$' {
            # Qualys 応答 XML は巨大になり得る(Host 1000件等)。ConvertTo-Json で包むと PS5.1 が
            # 落ちるので、XML は生 body、status / nextUrl は応答ヘッダで返す。
            try {
                $res = Invoke-QualysFetch (Get-Body $req | ConvertFrom-Json)
                $r = $Ctx.Response; Set-Cors $r
                $r.Headers['X-QAM-Status'] = [string]$res.status
                if ($res.nextUrl) { $r.Headers['X-QAM-Next'] = [Uri]::EscapeDataString([string]$res.nextUrl) }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$res.xml)
                $r.StatusCode = $(if ($res.ok) { 200 } else { 502 })
                $r.ContentType = 'application/xml; charset=utf-8'
                $r.ContentLength64 = $bytes.Length; $r.OutputStream.Write($bytes, 0, $bytes.Length); $r.OutputStream.Close()
            } catch {
                # 例外(プロキシ/ネットワーク等)は AggregateException で実体が Inner に入るので連結して出す。
                $msg = $_.Exception.Message
                $inner = $_.Exception.InnerException
                while ($inner) { $msg += ' <- ' + $inner.Message; $inner = $inner.InnerException }
                Write-Host "[qam] fetch ERROR: $msg" -ForegroundColor Red
                Add-QamLog "FETCH error: $msg"
                Send-Json $Ctx @{ ok = $false; error = $msg } 502
            }
            return
        }
        '^/qam/file/list$' {
            $dir = Resolve-SafePath $q['dir']
            if (-not (Test-Path -LiteralPath $dir)) { Send-Json $Ctx @{ names = @() }; return }
            Send-Json $Ctx @{ names = @(Get-ChildItem -LiteralPath $dir -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }; return
        }
        '^/qam/file/remove$' {
            $p = Resolve-SafePath (Get-Body $req | ConvertFrom-Json).path
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
            Send-Json $Ctx @{ ok = $true }; return
        }
        '^/qam/file$' {
            # 大きなファイル本体は JSON で包まず生 body で授受する。PS5.1 の ConvertTo/From-Json
            # (JavaScriptSerializer) は大きな文字列で失敗する（"System.String 型に変換できません"）ため。
            # path / append はクエリで渡す。
            if ($req.HttpMethod -eq 'POST') {
                $p = Resolve-SafePath $q['path']
                $dir = Split-Path $p -Parent
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                $content = Get-Body $req
                if ($q['append'] -eq '1') { Add-Content -LiteralPath $p -Value $content -Encoding UTF8 -NoNewline }
                else { Set-Content -LiteralPath $p -Value $content -Encoding UTF8 -NoNewline }
                Send-Json $Ctx @{ ok = $true }; return
            }
            $p = Resolve-SafePath $q['path']
            if (-not (Test-Path -LiteralPath $p)) { Send-Bytes $Ctx ([byte[]]@()) 'application/json; charset=utf-8' 404; return }
            $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8
            if ($null -eq $raw) { $raw = '' }
            Send-Text $Ctx $raw 'application/json; charset=utf-8'; return
        }
        '^/qam/config$' {
            if ($req.HttpMethod -eq 'POST') {
                $b = Get-Body $req | ConvertFrom-Json
                if ($b.PSObject.Properties.Name -contains 'retentionDays') { Set-QamEnvValue $EnvFile 'QAM_RAW_RETENTION_DAYS' ([int]$b.retentionDays) }
                if ($b.PSObject.Properties.Name -contains 'licenseLimit') { Set-QamEnvValue $EnvFile 'QAM_LICENSE_LIMIT' ([int]$b.licenseLimit) }
                if ($b.PSObject.Properties.Name -contains 'proxy') { Set-QamEnvValue $EnvFile 'QAM_PROXY_URL' $b.proxy }
                if ($b.PSObject.Properties.Name -contains 'qualysBase') { Set-QamEnvValue $EnvFile 'QAM_QUALYS_API_BASE' $b.qualysBase }
                if ($b.PSObject.Properties.Name -contains 'qualysUser') { Set-QamEnvValue $EnvFile 'QAM_QUALYS_USER' $b.qualysUser }
                Import-QamEnv $EnvFile
            }
            $baseV = $env:QAM_QUALYS_API_BASE; $userV = $env:QAM_QUALYS_USER; $proxyV = $env:QAM_PROXY_URL
            Write-Host ("[qam] config base={0} user={1} proxy={2}" -f `
                $(if ($baseV) { $baseV } else { '(空)' }), `
                $(if ($userV) { 'set' } else { '(空)' }), `
                $(if ($proxyV) { $proxyV } else { '(空)' })) -ForegroundColor Cyan
            Send-Json $Ctx @{
                qualysBase = $baseV; qualysUser = $userV; proxy = $proxyV; port = $Port
                retentionDays = if ($env:QAM_RAW_RETENTION_DAYS) { [int]$env:QAM_RAW_RETENTION_DAYS } else { 90 }
                licenseLimit = if ($env:QAM_LICENSE_LIMIT) { [int]$env:QAM_LICENSE_LIMIT } else { 0 }
            }; return
        }
        '^/qam/shutdown$' { Send-Json $Ctx @{ ok = $true }; $script:QamStop = $true; return }
        default { Send-Json $Ctx @{ error = "no route: $path" } 404; return }
    }
}

# ─── 起動 ────────────────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
# 127.0.0.1 と localhost の両方を受ける（HttpListener は Host が prefix と一致しないと標準 404 を返す）。
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "[qam] relay listening on http://127.0.0.1:$Port/ (+localhost)  (DataDir=$DataFull, BundleDir=$BundleDir)" -ForegroundColor Green
Add-QamLog "=== relay started: port=$Port DataDir=$DataFull BundleDir=$BundleDir ==="

while (-not $script:QamStop) {
    try { $ctx = $listener.GetContext() } catch { break }
    try { Invoke-Route $ctx }
    catch {
        $p = try { $ctx.Request.Url.AbsolutePath } catch { '?' }
        Write-Host "[qam][ERR] $p : $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ScriptStackTrace) { Write-Host ("  " + ($_.ScriptStackTrace -replace "`n", "`n  ")) -ForegroundColor DarkGray }
        Add-QamLog "ERR $p : $($_.Exception.Message)"
        try { Send-Json $ctx @{ error = $_.Exception.Message } 500 } catch { }
    }
}
$listener.Stop()
Write-Host '[qam] relay stopped' -ForegroundColor Yellow
