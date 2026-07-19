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

# 画面はすぐ流れるので、同じ内容をログにも残す（失敗の理由を後から追えるように）。
$LogPath = Join-Path $Root 'qam-launch.log'
function Write-Log {
    param([string]$Msg)
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Msg
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}
function Write-Step { param([string]$Msg) Write-Host "[qam] $Msg" -ForegroundColor Cyan; Write-Log "INFO  $Msg" }
function Write-Warn { param([string]$Msg) Write-Host "[qam] $Msg" -ForegroundColor Yellow; Write-Log "WARN  $Msg" }

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
    if (-not $edge) { Write-Warn 'Microsoft Edge が見つかりません（既定の場所に msedge.exe がありません）'; return $false }
    Write-Step "Edge: $edge"
    if (-not (Test-Path -LiteralPath $ProfilePath)) { New-Item -ItemType Directory -Path $ProfilePath -Force | Out-Null }
    Write-Step "専用プロファイル: $ProfilePath"
    # パスに空白が含まれると引数が途中で切れるので、値を引用符で囲む。
    $argList = @(
        "--user-data-dir=`"$ProfilePath`"",
        "--remote-debugging-port=$Port",
        '--remote-allow-origins=*',      # 無いと CDP の WebSocket 接続が拒否される
        '--no-first-run', '--no-default-browser-check',
        "`"$Url`""
    )
    Write-Step ("起動します: msedge " + ($argList -join ' '))
    try { Start-Process -FilePath $edge -ArgumentList $argList }
    catch { Write-Warn "Edge の起動に失敗しました: $($_.Exception.Message)"; return $false }
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Url "http://127.0.0.1:$Port/json/version") { Write-Step "デバッグポート応答あり (port $Port)"; return $true }
    }
    Write-Warn "Edge は起動しましたが、デバッグポート $Port が応答しませんでした（別プロファイルの Edge が既に動いている場合、--remote-debugging-port が無視されることがあります）"
    return $false
}

# ─── 3) CDP（WebSocket で Runtime.evaluate）──────────────────────────────────
# 対象タブの WebSocket URL を得る。SharePoint のタブを優先する。
function Get-CdpTarget {
    param([int]$Port, [string]$UrlLike)
    try { $list = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3 }
    catch { Write-Warn "CDP のタブ一覧を取得できません (port $Port): $($_.Exception.Message)"; return $null }
    $all = @($list | Where-Object { $_.type -eq 'page' })
    $pages = @($all | Where-Object { $_.webSocketDebuggerUrl })
    if ($all.Count -gt 0 -and $pages.Count -eq 0) {
        # webSocketDebuggerUrl は「既に別の DevTools クライアントが繋がっている」と返らない。
        # F12 を開いたままにしている場合や、前回の接続が残っている場合に起きる。
        Write-Warn 'タブに接続できません（開発者ツール(F12)が開いていると接続できません。閉じてから再実行してください）'
        return $null
    }
    $hit = $pages | Where-Object { $_.url -like "$UrlLike*" } | Select-Object -First 1
    if (-not $hit) { $hit = $pages | Select-Object -First 1 }
    return $hit
}

# CDP のセッション。ポーリングのたびに繋ぎ直すと接続が溜まるので、1 本を使い回す。
function New-CdpSession {
    param([string]$WsUrl, [int]$TimeoutSec = 20)
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
    try {
        $ws.ConnectAsync([Uri]$WsUrl, $cts.Token).Wait()
        return [pscustomobject]@{ Ws = $ws; Id = 0 }
    } catch {
        # ここを黙って握りつぶすと「Edge は出たのに何も起きない」になる。理由を必ず残す。
        $ex = $_.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }
        Write-Warn "CDP に接続できません: $($ex.Message)"
        Write-Warn '（Edge の起動オプションに --remote-allow-origins=* が要ります）'
        try { $ws.Dispose() } catch { }
        return $null
    } finally { $cts.Dispose() }
}

function Close-CdpSession {
    param($Session)
    if (-not $Session) { return }
    try {
        $cts = New-Object System.Threading.CancellationTokenSource
        $cts.CancelAfter([TimeSpan]::FromSeconds(3))
        $Session.Ws.CloseAsync('NormalClosure', 'bye', $cts.Token).Wait()
        $cts.Dispose()
    } catch { }
    try { $Session.Ws.Dispose() } catch { }
}

# ページ内で JS を評価して結果(JSON文字列)を返す。失敗時は $null。
function Invoke-CdpEvaluate {
    param($Session, [string]$Expression, [int]$TimeoutSec = 30)
    if (-not $Session -or $Session.Ws.State -ne 'Open') { return $null }
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
    try {
        $Session.Id++
        $msg = @{
            id = $Session.Id; method = 'Runtime.evaluate'
            params = @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
        } | ConvertTo-Json -Depth 6 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
        $Session.Ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, $cts.Token).Wait()
        # 目的の id が返るまで読む（イベントが混ざっても取り違えない）。
        $buf = New-Object byte[] 16384
        for ($try = 0; $try -lt 50; $try++) {
            $sb = New-Object Text.StringBuilder
            do {
                $res = $Session.Ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token)
                $res.Wait()
                [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Result.Count))
            } while (-not $res.Result.EndOfMessage)
            $text = $sb.ToString()
            if ($text -match ('"id"\s*:\s*' + $Session.Id + '\b')) { return $text }
        }
        return $null
    } catch {
        $ex = $_.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }
        Write-Warn "CDP の評価に失敗: $($ex.Message)"
        return $null
    } finally { $cts.Dispose() }
}

# ─── 4) ローダ（SharePoint のライブラリからアプリ本体を取って起動する）──────
# バンドルは SP のライブラリに置いてあるので、更新はそこを差し替えるだけで全員に反映される。
# ★初回は SharePoint にまだアプリ本体が無い（配置はアプリの画面から行うため）。
#   そこで「SP のライブラリ → 無ければローカル relay」の順に取りに行く。
#   これで最初の1回も起動でき、配置後は全員が SP 側の最新を使う。
$LoaderJs = @'
(async () => {
  if (document.getElementById('qam-root')) return 'already';
  // ★アプリ本体に中継サーバの居場所を伝える。
  //   ここを渡さないとアプリは既定ポートを見に行き、設定が取れず
  //   「SharePoint に接続できません」になる（ポートを変えた環境で必ず踏む）。
  try { localStorage.setItem('qam:relayUrl', 'http://127.0.0.1:__RELAY_PORT__'); } catch (e) {}
  const m = location.pathname.match(/^\/(?:sites|teams)\/[^\/]+/);
  const web = location.origin + (m ? m[0] : '');
  const tryFetch = async (u, opt) => { try { const r = await fetch(u, opt); return r.ok ? await r.text() : null; } catch (e) { return null; } };
  let js = await tryFetch(web + '/QamData/app/qam.bundle.js?t=' + Date.now(), { credentials: 'include' });
  let from = 'sharepoint';
  if (!js) { js = await tryFetch('http://127.0.0.1:__RELAY_PORT__/qam/bundle/qam.bundle.js', {}); from = 'relay'; }
  if (!js) return 'bundle-missing';
  // 起動時の失敗を握り潰さない。ここで黙ると「注入は成功したのに何も出ない」になり、
  // 画面にもログにも手がかりが残らない。
  try { (0, eval)(js); } catch (e) { return 'eval-error: ' + (e && e.message) + ' @ ' + String(e && e.stack).split('\n')[1]; }
  const root = document.getElementById('qam-root');
  if (!root) return 'no-root: 本体は読めたが画面を作れていない';
  const r = root.getBoundingClientRect();
  if (r.width < 50 || r.height < 50) return 'invisible: root ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' (CSS が当たっていない)';
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
Write-Log '--- 起動 ---'
if (-not $SiteUrl) { $SiteUrl = Get-EnvValue 'QAM_SP_SITE_URL' }
if (-not $SiteUrl) {
    # ★ここで終わると「ブラウザが何も出ない」うえ、サイト URL を設定する画面にも辿り着けない
    #   （設定画面はアプリの中にあるため）。ローカルの画面を開いて、そこで入力してもらう。
    Write-Warn 'SharePoint サイト URL が未設定です（server\qam.env の QAM_SP_SITE_URL）'
    Write-Warn '設定用にローカルの画面を開きます。表示される画面でサイト URL を入力し、保存してから、もう一度 qam-start.bat を実行してください'
    if (-not (Start-QamRelay -Port $RelayPort)) { Write-Warn '中継サーバを起動できませんでした' }
    try { Start-Process "http://127.0.0.1:$RelayPort/" } catch { Write-Warn "手動で開いてください: http://127.0.0.1:$RelayPort/" }
    if ($KeepOpen) { Read-Host '終了するには Enter' }
    exit 1
}
Write-Step "接続先: $SiteUrl"
Write-Step "中継サーバ: http://127.0.0.1:$RelayPort/  デバッグポート: $DebugPort" 

$ok = $false
try {
    if (-not (Start-QamRelay -Port $RelayPort)) { throw '中継サーバを起動できませんでした' }
    if (-not (Start-QamEdge -Url $SiteUrl -Port $DebugPort -ProfilePath $ProfileDir)) { throw '専用ブラウザを起動できませんでした' }

    Write-Step 'サインインの完了を待っています（ブラウザの画面で普段どおりサインインしてください）'
    $deadline = (Get-Date).AddSeconds($AuthTimeoutSec)
    $authed = $false
    $session = $null
    $lastUrl = ''
    while ((Get-Date) -lt $deadline) {
        $t = Get-CdpTarget -Port $DebugPort -UrlLike $SiteUrl
        if (-not $t) { Write-Step 'ブラウザのタブを探しています…'; Start-Sleep -Seconds 2; continue }
        # 対象タブが変わったら（サインイン→SharePoint 等）繋ぎ直す。
        if ($t.url -ne $lastUrl) {
            Write-Step ("現在のページ: " + $t.url)
            Close-CdpSession $session
            $session = New-CdpSession -WsUrl $t.webSocketDebuggerUrl
            $lastUrl = $t.url
        }
        if (-not $session) { Start-Sleep -Seconds 2; continue }
        $res = Invoke-CdpEvaluate -Session $session -Expression $AuthProbeJs -TimeoutSec 20
        if ($res -and $res -match '"value"\s*:\s*"ok"') { $authed = $true; break }
        if ($res -and $res -match '"value"\s*:\s*"status:(\d+)"') {
            Write-Step ("SharePoint の応答待ち (HTTP " + $Matches[1] + ") — サインインが完了すると進みます")
        } else {
            Write-Step 'サインイン待ち…'
        }
        Start-Sleep -Seconds 3
    }
    if (-not $authed) {
        Close-CdpSession $session
        throw "サインインを確認できませんでした（$AuthTimeoutSec 秒で時間切れ。最後に見えていたページ: $lastUrl）"
    }

    Write-Step 'アプリを起動します'
    $res = Invoke-CdpEvaluate -Session $session -Expression $LoaderJs -TimeoutSec 60
    Close-CdpSession $session
    if (-not $res) { throw 'アプリの注入に失敗しました（CDP の応答がありません）' }
    Write-Log ("LOADER 応答: " + $res)
    if ($res -match 'bundle-missing') {
        throw 'アプリ本体を取得できません（SharePoint にも中継サーバにも見つかりません）'
    }
    # 本体は読めたが起動できなかった場合。ここを成功扱いにすると
    # 「起動しました」と出たまま画面に何も出ず、原因が追えなくなる。
    foreach ($pat in 'eval-error','no-root','invisible') {
        if ($res -match ('"value"\s*:\s*"(' + $pat + '[^"]*)"')) { throw ('アプリを起動できませんでした: ' + $Matches[1]) }
    }
    if ($res -match 'started:relay') {
        Write-Warn 'SharePoint にアプリ本体がまだありません。中継サーバから起動しました'
        Write-Warn '設定 → 開発者 →「アプリを SharePoint に配置」を一度実行してください'
    }
    Write-Step '起動しました'
    $ok = $true
} catch {
    Write-Warn "起動に失敗しました: $($_.Exception.Message)"
    Write-Warn "詳しい経過はログを確認してください: $LogPath"
    # フォールバック: 既定ブラウザで SharePoint を開く。
    # ★ここで普通のブラウザが開くので「専用 Edge が上がらない」ように見える。理由を先に出しておく。
    Write-Warn '代わりに既定のブラウザで SharePoint を開きます（専用ブラウザではありません）'
    try { Start-Process $SiteUrl } catch { }
}
if ($KeepOpen -and -not $ok) { Read-Host '終了するには Enter' }
