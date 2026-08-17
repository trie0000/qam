# =============================================================================
# intra-mail.ps1 — 社内イントラからのファイル取得と、Outlook のメール下書き
# =============================================================================
# ★このファイルはアプリに依存しない。別のツールへそのままコピーして使えるよう、
#   ホスト側のヘルパ（ログ・認証情報の復号・HTTP 応答）を呼ばない作りにしてある。
#   使う側は次だけを行う:
#     1. . "$PSScriptRoot\intra-mail.ps1"   （読み込み）
#     2. パスワードを復号して $body.psw に入れてから関数を呼ぶ
#     3. 戻り値（ordered hashtable）を自前の JSON 応答で返す
#   ログが要る場合は -Log に scriptblock を渡す（既定は何もしない）。
# =============================================================================
Add-Type -AssemblyName System.Net.Http | Out-Null

# ─── 社内イントラからのファイル取得 ─────────────────────────────────────────
# Global ID + パスワードのフォーム認証 → セッションのまま目的ページを取得 →
# 指定パターンのリンクを見つけて本体をダウンロードする。
#
# ★Qualys 用の経路とは別クライアントを立てる。あちらは Basic 認証で
#   UseCookies=$false 固定だが、こちらはセッションクッキーが要る。
# ★イントラなのでプロキシは使わない（社内向けにプロキシを通すと届かない）。
# ★クッキーはこの関数の中で完結させ、ブラウザ側へは渡さない。
function Invoke-IntraFetchFile { param($Body, [scriptblock]$Log = $null)
    $loginUrl = [string]$Body.loginUrl
    $pageUrl = [string]$Body.pageUrl
    if (-not $loginUrl -or -not $pageUrl) { return [ordered]@{ ok = $false; error = 'ログインURL / ページURL が未設定です' } }
    $pattern = if ($Body.pattern) { [string]$Body.pattern } else { '^ITSecurity.*\.xlsx?$' }

    # ★HttpClientHandler の設定は「最初のリクエストより前」しか変えられない
    #   （後から変えると This instance has already started one or more requests で落ちる）。
    #   ログインは 302 を見たいので追わない、その後は普通に追いたい——設定が違うので
    #   クライアントを 2 つ作り、CookieContainer だけを共有してセッションを引き継ぐ。
    $jar = New-Object System.Net.CookieContainer
    $newHandler = {
        param([bool]$follow)
        $h = New-Object System.Net.Http.HttpClientHandler
        $h.UseCookies = $true
        $h.CookieContainer = $jar
        $h.AllowAutoRedirect = $follow
        $h.UseProxy = $false            # イントラは直接続
        $h.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
        return $h
    }
    $handler = & $newHandler $false     # ログイン用（302 が成功の合図なので追わない）
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(180)
    $handler2 = & $newHandler $true     # ログイン後用（通常の遷移は追う）
    $client2 = New-Object System.Net.Http.HttpClient($handler2)
    $client2.Timeout = [TimeSpan]::FromSeconds(180)
    try {
        $client.DefaultRequestHeaders.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

        # 1) ログイン
        # ★New-Object にコレクションを渡すと**中身が展開されて別々の引数になる**。
        #   要素2個なら「引数の数が 2 のオーバーロードが見つかりません」で落ちる（実際に踏んだ）。
        #   ::new() なら展開されないので、そちらを使う。
        $kv = { param($k, $v) [System.Collections.Generic.KeyValuePair[String, String]]::new($k, $v) }
        $form = [System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[String, String]]]::new()
        $form.Add((& $kv 'uid' ([string]$Body.uid)))
        $form.Add((& $kv 'psw' ([string]$Body.psw)))
        $content = [System.Net.Http.FormUrlEncodedContent]::new($form)
        if ($Log) { & $Log "INTRA login POST $loginUrl" }
        # ★接続失敗の扱い。このファイルはホストの $ErrorActionPreference に依存しないので、
        #   例外が飛ぶとは限らない（Stop でない環境では $null が返り、[int]$null.StatusCode が 0 になって
        #   「HTTP 0」という手掛かりの無いメッセージになる）。$null を明示的に見る。
        $login = $null
        try { $login = $client.PostAsync($loginUrl, $content).Result } catch { $login = $null; $connErr = $_ }
        if ($null -eq $login) {
            $msg = 'ログイン先へ接続できません'
            if ($connErr) { $ex = $connErr.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }; $msg += ": $($ex.Message)" }
            return [ordered]@{ ok = $false; error = "$msg（$loginUrl）" }
        }
        $code = [int]$login.StatusCode
        # 302 = ログイン成功。200 が返るのは入力画面に戻された＝失敗であることが多い。
        if ($code -ne 302 -and $code -ne 303 -and $code -ne 200) {
            return [ordered]@{ ok = $false; error = "ログインに失敗しました (HTTP $code)" }
        }
        $cookies = $handler.CookieContainer.GetCookies([Uri]$loginUrl)
        if ($cookies.Count -eq 0) {
            return [ordered]@{ ok = $false; error = "ログインしましたがセッションのクッキーが返りませんでした (HTTP $code)。ID/パスワードを確認してください" }
        }

        # 2) 目的ページ（ログイン後用のクライアント。クッキーは共有している）
        $client2.DefaultRequestHeaders.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
        $page = $null
        try { $page = $client2.GetAsync($pageUrl).Result } catch { $page = $null; $pageErr = $_ }
        if ($null -eq $page) {
            $msg = 'ページへ接続できません'
            if ($pageErr) { $ex = $pageErr.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }; $msg += ": $($ex.Message)" }
            return [ordered]@{ ok = $false; error = "$msg（$pageUrl）" }
        }
        if (-not $page.IsSuccessStatusCode) {
            return [ordered]@{ ok = $false; error = "ページを取得できません (HTTP $([int]$page.StatusCode))" }
        }
        $html = $page.Content.ReadAsStringAsync().Result

        # 3) リンク抽出。href の最後の要素（ファイル名）をパターンで判定する。
        $hit = $null
        foreach ($m in [regex]::Matches($html, '(?i)href\s*=\s*["'']([^"'']+)["'']')) {
            $href = $m.Groups[1].Value
            $name = [IO.Path]::GetFileName(($href -split '\?')[0])
            if ($name -match $pattern) { $hit = $href; break }
        }
        if (-not $hit) { return [ordered]@{ ok = $false; error = "パターン ($pattern) に合うリンクがページに見つかりません" } }
        $fileUrl = [Uri]::new([Uri]$pageUrl, $hit).AbsoluteUri

        # 4) 本体
        if ($Log) { & $Log "INTRA download $fileUrl" }
        $dl = $null
        try { $dl = $client2.GetAsync($fileUrl).Result } catch { $dl = $null }
        if ($null -eq $dl) { return [ordered]@{ ok = $false; error = "ファイルへ接続できません（$fileUrl）" } }
        if (-not $dl.IsSuccessStatusCode) {
            return [ordered]@{ ok = $false; error = "ファイルを取得できません (HTTP $([int]$dl.StatusCode)): $fileUrl" }
        }
        $bytes = $dl.Content.ReadAsByteArrayAsync().Result
        return [ordered]@{
            ok = $true; name = [IO.Path]::GetFileName(($fileUrl -split '\?')[0])
            url = $fileUrl; bytes = $bytes.Length; base64 = [Convert]::ToBase64String($bytes)
        }
    } catch {
        return [ordered]@{ ok = $false; error = $_.Exception.Message }
    } finally { $client.Dispose(); $handler.Dispose(); $client2.Dispose(); $handler2.Dispose() }
}

# ─── Outlook のメール下書き ─────────────────────────────────────────────────
# ★★★ 下書きを表示するところまでしか行わない。.Send() は絶対に呼ばない。★★★
#   送信は利用者が Outlook で内容を確認してから自分で押す。誤送信を防ぐため、
#   この方針は変えないこと。
function Invoke-OutlookDraft { param($Body, [scriptblock]$Log = $null)
    if (-not $Body.to) { return [ordered]@{ ok = $false; error = '宛先が空です' } }
    try { $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
    catch { try { $outlook = New-Object -ComObject Outlook.Application } catch { $outlook = $null } }
    if (-not $outlook) { return [ordered]@{ ok = $false; error = 'Outlook を操作できません（起動しているか確認してください）' } }
    try {
        $mail = $outlook.CreateItem(0)   # 0 = olMailItem
        $mail.To = [string]$Body.to
        $mail.Subject = [string]$Body.subject
        if ($Body.cc) { $mail.CC = [string]$Body.cc }
        if ($Body.replyTo) { $mail.ReplyRecipientNames = [string]$Body.replyTo }
        # ★テキストメールで作る。HTML にすると受け手の環境で見え方が変わり、
        #   引用や転送のときにも崩れる。Body に入れれば Outlook はテキスト形式で開く。
        $mail.Body = [string]$Body.body
        # ★ここで .Send() は絶対に呼ばない。下書きを開くだけ。
        $insp = $mail.GetInspector
        $insp.Display()
        try { $insp.Activate() } catch { }
        if ($Log) { & $Log ("OUTLOOK draft to=" + [string]$Body.to) }
        return [ordered]@{ ok = $true }
    } catch { return [ordered]@{ ok = $false; error = $_.Exception.Message } }
}

