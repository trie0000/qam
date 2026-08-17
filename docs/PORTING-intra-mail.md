# 社内イントラ取得 / 連絡先 / メール下書き — 他ツールへの移植手順

イントラの体制表から連絡先を取り、Outlook のメール下書きを作る部分は、
**アプリに依存しない部品**として切り出してある。別のツールへは以下をコピーするだけでよい。

## コピーするファイル（5つ）

| ファイル | 役割 | 依存 |
|---|---|---|
| `dist/intra-mail.ps1` | イントラのフォーム認証＋ファイル取得、Outlook の下書き作成 | なし（.NET のみ） |
| `src/xlsx-read.ts` | .xlsx の読み取り（ZIP → シート → セル） | なし |
| `src/contacts.ts` | 体制表から「正」の連絡先を抽出 | `xlsx-read.ts` の型のみ |
| `src/mail.ts` | テンプレートの差し込み・下書きの組み立て | なし |
| `src/api/intra-mail.ts` | 上記2経路への HTTP クライアント | `mail.ts` の型のみ |

テストも一緒に持っていける: `test/xlsx-read.test.ts` / `test/contacts.test.ts`。

## 中継サーバ側で行う配線

```powershell
. (Join-Path $PSScriptRoot 'intra-mail.ps1')

# 1) 認証情報の復号は各アプリの責任。平文にしてから psw に入れて渡す。
$b = $Body | Select-Object *
$b | Add-Member -NotePropertyName psw -NotePropertyValue (自前の復号 $Body) -Force
$res = Invoke-IntraFetchFile $b { param($t) 自前のログ $t }

# 2) 下書き。★Display() までで .Send() は絶対に呼ばない。
$res = Invoke-OutlookDraft $Body { param($t) 自前のログ $t }
```

ルート名は自由。このリポジトリでは `/qam/intra/fetch-file` と `/qam/outlook/draft`。
`src/api/intra-mail.ts` のパスをそれに合わせて変えること。

## 各アプリで用意するもの（＝移植しない部分）

- **設定の保管**: ログインURL / ページURL / Global ID / パスワード（暗号化して保存すること）
- **メールのテンプレート**: 件名・本文・CC・Reply-To。`mail.ts` は `{{キー}}` を差し替えるだけで、
  どんなキーを使うかは呼び出し側が決める
- **宛先の決定**: 「管轄範囲（体制表の会社名）」と自アプリ側の会社名の対応付け

## 守ること

- **メールはテキスト形式で作る。** `MailItem.Body` に入れる（`HTMLBody` は使わない）。
- **メールは絶対に自動送信しない。** `Invoke-OutlookDraft` は下書きを表示するところまで。
  `build.js` に「中継サーバへ `.Send()` が混入していないか」を検査するガードがあるので、
  移植先にも同じ検査を入れること。
- **クッキーを中継サーバの外へ出さない。** ログインから目的ファイルの取得までを 1 回の
  呼び出しで完結させている（ブラウザ側にセッションを渡さないため）。
- **イントラへはプロキシを使わない。** `UseProxy = $false` を明示している。
