# =============================================================================
# qam-launch.ps1 — アイコンのクリックだけで QAM を起動する（CDP 方式）
# =============================================================================
# やること:
#   1) relay(127.0.0.1) の起動を待つ（落ちていれば起動する）
#   2) 専用プロファイルの Edge を起動（--remote-debugging-port / --remote-allow-origins=*）
#   3) SharePoint の認証完了を待つ（_api/web が引けるまでポーリング）
#   4) CDP の Runtime.evaluate でローダを注入 → アプリが overlay として立ち上がる
#   5) どこかで失敗したら、既定ブラウザで SharePoint を開いて手動起動に案内する
#
# 方針（外すと事故る）:
#   - **ヘッドレスにしない。** MFA / SSO / 条件付きアクセスの対話ができず、サインインが完了しない
#   - **専用プロファイルは %LOCALAPPDATA% 配下。** Desktop/Documents 配下だとクラウド同期の
#     対象になり、ロック競合でプロファイルが壊れる
#   - **既存プロファイルを移動・作り直ししない。** 全員の再サインインを招く
#   - **--remote-allow-origins=* が要る。** 無いと CDP の WebSocket 接続が拒否される
#   - **二重起動しない。** /json/version が応答したら既存を使う（プロファイルのロック競合防止）
#   - アプリは認証情報に触らない。CDP は「認証済みページに JS を注入する」だけなので、
#     MFA / SSO / 条件付きアクセスはそのまま機能する
# =============================================================================
[CmdletBinding()]
param(
    [string]$SiteUrl,                 # 例 https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE
    [int]$RelayPort = 18090,
    [int]$DebugPort = 18099,
    [int]$AuthTimeoutSec = 300,       # サインインを待つ上限（MFA を手で通す時間）
    [switch]$KeepOpen                 # 失敗時にウィンドウを残す（調査用）
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProfileDir = Join-Path $env:LOCALAPPDATA 'qam-edge'   # ユーザーごと・マシンローカル

function Write-Step { param([string]$Msg) Write-Host "[qam] $Msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "[qam] $Msg" -ForegroundColor Yellow }

# 設定ファイルから既定値を拾う（引数 > qam.env）。
function Get-EnvValue {
    param([string]$Key)
    $envFile = Join-Path $Root 'qam.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return '' }
    foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('='); if ($eq -lt 1) { continue }
        if ($t.Substring(0, $eq).Trim() -eq $Key) { return $t.Substring($eq + 1).Trim().Trim('"').Trim("'") }
    }
    return ''
}

function Test-Url {
    param([string]$Url, [int]$TimeoutSec = 2)
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec; return $true } catch { return $false }
}

# ─── 1) relay ────────────────────────────────────────────────────────────────
function Start-QamRelay {
    param([int]$Port)
    if (Test-Url "http://127.0.0.1:$Port/qam/health") { Write-Step "中継サーバは起動済み"; return $true }
    $relay = Join-Path $Root 'qam-relay.ps1'
    if (-not (Test-Path -LiteralPath $relay)) { Write-Warn "qam-relay.ps1 が見つかりません: $relay"; return $false }
    Write-Step "中継サーバを起動します"
    Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $relay, '-Port', $Port)
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Url "http://127.0.0.1:$Port/qam/health") { return $true }
    }
    return $false
}

# ─── 2) Edge（専用プロファイル・デバッグポート付き）─────────────────────────
function Get-EdgePath {
    foreach ($p in @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )) { if (Test-Path -LiteralPath $p) { return $p } }
    return ''
}

function Start-QamEdge {
    param([string]$Url, [int]$Port, [string]$ProfilePath)
    # 二重起動ガード: 既にデバッグポートが応答するなら、そのまま使う。
    if (Test-Url "http://127.0.0.1:$Port/json/version") { Write-Step "専用ブラウザは起動済み"; return $true }
    $edge = Get-EdgePath
    if (-not $edge) { Write-Warn 'Microsoft Edge が見つかりません'; return $false }
    if (-not (Test-Path -LiteralPath $ProfilePath)) { New-Item -ItemType Directory -Path $ProfilePath -Force | Out-Null }
    Write-Step "専用プロファイルの Edge を起動します"
    Start-Process -FilePath $edge -ArgumentList @(
        "--user-data-dir=$ProfilePath",
        "--remote-debugging-port=$Port",
        '--remote-allow-origins=*',      # 無いと CDP の WebSocket 接続が拒否される
        '--no-first-run', '--no-default-browser-check',
        $Url
    )
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Url "http://127.0.0.1:$Port/json/version") { return $true }
    }
    return $false
}

# ─── 3) CDP（WebSocket で Runtime.evaluate）──────────────────────────────────
# 対象タブの WebSocket URL を得る。SharePoint のタブを優先する。
function Get-CdpTarget {
    param([int]$Port, [string]$UrlLike)
    try { $list = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3 } catch { return $null }
    $pages = @($list | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl })
    $hit = $pages | Where-Object { $_.url -like "$UrlLike*" } | Select-Object -First 1
    if (-not $hit) { $hit = $pages | Select-Object -First 1 }
    return $hit
}

# ページ内で JS を評価して結果(JSON文字列)を返す。失敗時は $null。
function Invoke-CdpEvaluate {
    param([string]$WsUrl, [string]$Expression, [int]$TimeoutSec = 30)
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
    try {
        $ws.ConnectAsync([Uri]$WsUrl, $cts.Token).Wait()
        $msg = @{
            id = 1; method = 'Runtime.evaluate'
            params = @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
        } | ConvertTo-Json -Depth 6 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
        $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, $cts.Token).Wait()
        # 応答は分割して届くことがあるので EndOfMessage まで読む。
        $sb = New-Object Text.StringBuilder
        $buf = New-Object byte[] 8192
        do {
            $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token)
            $res.Wait()
            [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Result.Count))
        } while (-not $res.Result.EndOfMessage)
        return $sb.ToString()
    } catch { return $null }
    finally { try { $ws.Dispose() } catch { } ; $cts.Dispose() }
}

# ─── 4) ローダ（SharePoint のライブラリからアプリ本体を取って起動する）──────
# バンドルは SP のライブラリに置いてあるので、更新はそこを差し替えるだけで全員に反映される。
# ★初回は SharePoint にまだアプリ本体が無い（配置はアプリの画面から行うため）。
#   そこで「SP のライブラリ → 無ければローカル relay」の順に取りに行く。
#   これで最初の1回も起動でき、配置後は全員が SP 側の最新を使う。
$LoaderJs = @'
(async () => {
  if (document.getElementById('qam-root')) return 'already';
  const m = location.pathname.match(/^\/(?:sites|teams)\/[^\/]+/);
  const web = location.origin + (m ? m[0] : '');
  const tryFetch = async (u, opt) => { try { const r = await fetch(u, opt); return r.ok ? await r.text() : null; } catch (e) { return null; } };
  let js = await tryFetch(web + '/QamData/app/qam.bundle.js?t=' + Date.now(), { credentials: 'include' });
  let from = 'sharepoint';
  if (!js) { js = await tryFetch('http://127.0.0.1:__RELAY_PORT__/qam/bundle/qam.bundle.js', {}); from = 'relay'; }
  if (!js) return 'bundle-missing';
  (0, eval)(js);
  return 'started:' + from;
})()
'@
$LoaderJs = $LoaderJs.Replace('__RELAY_PORT__', [string]$RelayPort)

# 認証が通ったかの判定（SP の API が引けるか）。
$AuthProbeJs = @'
(async () => {
  const m = location.pathname.match(/^\/(?:sites|teams)\/[^\/]+/);
  const web = location.origin + (m ? m[0] : '');
  try {
    const r = await fetch(web + '/_api/web?$select=Title', { credentials: 'include', headers: { Accept: 'application/json;odata=nometadata' } });
    return r.ok ? 'ok' : 'status:' + r.status;
  } catch (e) { return 'error'; }
})()
'@

# ─── 実行 ────────────────────────────────────────────────────────────────────
if (-not $SiteUrl) { $SiteUrl = Get-EnvValue 'QAM_SP_SITE_URL' }
if (-not $SiteUrl) {
    Write-Warn 'SharePoint サイト URL が分かりません（-SiteUrl か qam.env の QAM_SP_SITE_URL を設定してください）'
    if ($KeepOpen) { Read-Host '終了するには Enter' }
    exit 1
}

$ok = $false
try {
    if (-not (Start-QamRelay -Port $RelayPort)) { throw '中継サーバを起動できませんでした' }
    if (-not (Start-QamEdge -Url $SiteUrl -Port $DebugPort -ProfilePath $ProfileDir)) { throw '専用ブラウザを起動できませんでした' }

    Write-Step 'サインインの完了を待っています（ブラウザの画面で普段どおりサインインしてください）'
    $deadline = (Get-Date).AddSeconds($AuthTimeoutSec)
    $authed = $false
    while ((Get-Date) -lt $deadline) {
        $t = Get-CdpTarget -Port $DebugPort -UrlLike $SiteUrl
        if ($t) {
            $res = Invoke-CdpEvaluate -WsUrl $t.webSocketDebuggerUrl -Expression $AuthProbeJs -TimeoutSec 20
            if ($res -and $res -match '"value"\s*:\s*"ok"') { $authed = $true; break }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $authed) { throw 'サインインを確認できませんでした（時間切れ）' }

    Write-Step 'アプリを起動します'
    $t = Get-CdpTarget -Port $DebugPort -UrlLike $SiteUrl
    $res = Invoke-CdpEvaluate -WsUrl $t.webSocketDebuggerUrl -Expression $LoaderJs -TimeoutSec 60
    if (-not $res) { throw 'アプリの注入に失敗しました' }
    if ($res -match 'bundle-missing') {
        throw 'アプリ本体を取得できません（SharePoint にも中継サーバにも見つかりません）'
    }
    if ($res -match 'started:relay') {
        Write-Warn 'SharePoint にアプリ本体がまだありません。中継サーバから起動しました'
        Write-Warn '設定 → 開発者 →「アプリを SharePoint に配置」を一度実行してください'
    }
    Write-Step '起動しました'
    $ok = $true
} catch {
    Write-Warn $_.Exception.Message
    # フォールバック: 既定ブラウザで SharePoint を開き、手動起動（ブックマークレット）に案内する。
    Write-Warn '既定のブラウザで SharePoint を開きます。ブックマークレットから起動してください'
    try { Start-Process $SiteUrl } catch { }
}
if ($KeepOpen -and -not $ok) { Read-Host '終了するには Enter' }
