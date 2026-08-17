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

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseCookies = $true
    $handler.CookieContainer = New-Object System.Net.CookieContainer
    $handler.AllowAutoRedirect = $false   # 302 が成功の合図なので追わない
    $handler.UseProxy = $false            # イントラは直接続
    $handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(180)
    try {
        $client.DefaultRequestHeaders.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

        # 1) ログイン
        $form = New-Object 'System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[String,String]]'
        $form.Add((New-Object 'System.Collections.Generic.KeyValuePair[String,String]'('uid', [string]$Body.uid)))
        $form.Add((New-Object 'System.Collections.Generic.KeyValuePair[String,String]'('psw', ([string]$Body.psw))))
        $content = New-Object System.Net.Http.FormUrlEncodedContent($form)
        if ($Log) { & $Log "INTRA login POST $loginUrl" }
        $login = $client.PostAsync($loginUrl, $content).Result
        $code = [int]$login.StatusCode
        # 302 = ログイン成功。200 が返るのは入力画面に戻された＝失敗であることが多い。
        if ($code -ne 302 -and $code -ne 303 -and $code -ne 200) {
            return [ordered]@{ ok = $false; error = "ログインに失敗しました (HTTP $code)" }
        }
        $cookies = $handler.CookieContainer.GetCookies([Uri]$loginUrl)
        if ($cookies.Count -eq 0) {
            return [ordered]@{ ok = $false; error = "ログインしましたがセッションのクッキーが返りませんでした (HTTP $code)。ID/パスワードを確認してください" }
        }

        # 2) 目的ページ
        $handler.AllowAutoRedirect = $true  # ここから先は通常の遷移を追う
        $page = $client.GetAsync($pageUrl).Result
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
        $dl = $client.GetAsync($fileUrl).Result
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
    } finally { $client.Dispose(); $handler.Dispose() }
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
        # 和文フォントを明示しないと Outlook が HTML 既定の Times New Roman で描画する。
        $mail.HTMLBody = '<div style="font-family:''游ゴシック'',''Yu Gothic'',''Meiryo UI'',sans-serif;font-size:11pt;color:#000;">' +
            [string]$Body.bodyHtml + '</div>'
        # ★ここで .Send() は絶対に呼ばない。下書きを開くだけ。
        $insp = $mail.GetInspector
        $insp.Display()
        try { $insp.Activate() } catch { }
        if ($Log) { & $Log ("OUTLOOK draft to=" + [string]$Body.to) }
        return [ordered]@{ ok = $true }
    } catch { return [ordered]@{ ok = $false; error = $_.Exception.Message } }
}

