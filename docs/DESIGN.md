# QAM 詳細設計

対象: Qualys VMDR の AssetGroup / Host / Domain の登録状況と改廃履歴。
UI は Spira デザインルール（全アプリ共通）/ 開発基準（bookmarklet アプリ共通）に準拠。
本ツールは **bookmarklet 型ではないローカル単体ツール**のため、SP オリジン関連規約
（all:initial シールド、ローダ 2MB 制限、SP REST 書込みの罠）は非該当。
ローカルリレー作法（127.0.0.1 / env / health / 1 行ログ）と UI 規約は全面適用。

## 1. 取り込み（ingestion）

- 当面: Qualys の UI/API で取得した一覧 XML を UI からアップロード。
- 将来: PowerShell が Qualys API を直接呼ぶ（Phase 4）。
- **取り込み口を `qam-ingest.ps1` に隔離**し、「XML アップロード」と「API 直叩き」が
  同一の正規化関数に合流する形にする（UI・差分ロジックを変更せず後付け可能）。

対象 API（参考）: `/api/2.0/fo/asset/group/?action=list` /
`/api/2.0/fo/asset/host/?action=list` / `/api/2.0/fo/asset/domain/?action=list`。
Host 一覧は `truncation_limit` でページングされ末尾 `<WARNING><URL>` に次ページが入る
（Phase 4 で考慮）。

## 2. ストレージ

`<QAM_DATA_DIR>/` 配下（README 記載のレイアウト）。DB は使わずファイル。

### 同一性キー
| エンティティ | キー | 備考 |
|---|---|---|
| AssetGroup | `ID` | 安定 |
| Host | `ID`（Qualys Host ID） | IP/DNS は変わるのでキーにしない |
| Domain | ドメイン文字列 | Qualys のドメインに ID は無い |

### 履歴イベント（`history/<entity>.jsonl` 1 行）
```json
{"eid":"host:12345:2026-06-13:DNS","ts":"2026-06-13","entity":"host",
 "id":"12345","name":"web01","change":"modified","field":"DNS",
 "old":"web01.old","new":"web01.new"}
```
- `change` = `added | modified | deleted`。added/deleted は field/old/new 空。
- `eid` = `<entity>:<id>:<ts>:<field>` のような安定キー（コメント紐付け用）。

### 現況（`current/<entity>.json`）
キー（ID/ドメイン）→ 正規化レコードの辞書。差分の相手かつ「資産一覧」表示の元。

### コメント（`comments/comments.jsonl` 1 行）
```json
{"ts":"2026-06-13T09:00:00Z","target":"event","key":"host:12345:2026-06-13:DNS",
 "author":"<user>","text":"対応済み。申請 #123 に紐付け"}
```
- `target` = `event`（変更イベント）/ `asset`（資産 ID）。← 付与単位は要確定（下記）。

### 取込メタ（`runs.jsonl`）
`{ "ts", "entity", "count", "added", "modified", "deleted", "completed" }`

## 3. 差分エンジン（`qam-diff.ps1`）

1. 各レコードを正規化し `content_hash` を算出。
2. 前回 `current/<entity>.json` と突合:
   - 新規キー → `added`
   - hash 変化 → `modified`（フィールド単位の差分を展開）
   - 消失キー → `deleted`
   - hash 同一 → 何も追記しない（履歴行を増やさない）
3. 変更を `history/<entity>.jsonl` に追記、`current/<entity>.json` を更新、`runs.jsonl` 追記。

### 安全策
- **誤取込ガード**: XML パース失敗、または件数が前回比 `QAM_SHRINK_GUARD_RATIO` 以上に急減
  （または 0）なら、即コミットせずステージし、UI のモーダルで確認（誤った XML での「全削除」防止）。
- **冪等**: 同一日付の再取込は二重記録せず、その日の run を置換。

## 4. UI（Spira 準拠）

ビュー並びは §1.2 厳守（タイトル subbar → toolbar → 本体）。

```
TopBar(44px): QAM       [取込][更新][設定][終了]   ← Feather icon + aria-label
LeftPane(200px) | Tabs: [AssetGroup][Host][Domain]
 ◉ 資産一覧      | Subbar: ビュー名 + 件数
 ○ 変更履歴      | Toolbar: 検索 / 期間(from-to) / フィルタ / ソート
 (絞り込み)      | Table（sticky header・paper 不透明・§7）
```

- 左ペイン: モード切替「資産一覧（現況）/ 変更履歴」＋絞り込み。active は左ボーダー＋`accent-soft`。
- タブ: エンティティ（AssetGroup/Host/Domain）。§23。
- 変更履歴の列: `日付 | 種別 | ID | 名前 | 項目 | 変更前 | 変更後 | コメント`。
  種別タグ色 added=`--ok` / modified=`--warn` / deleted=`--danger`。ID/タグは mono。
- フィルタ: 期間（date input）・資産名・IP・FQDN・種別。
  **Enter を拾う全ハンドラに `if (e.isComposing || e.keyCode === 229) return;`（§6）**。
- コメント: §6.3 の textarea＋右下送信ボタン型。§8「送信成功までモーダルを閉じない」。成功時 §9 右上トースト。
- アイコン: Feather（stroke 1.7, 24x24 viewBox, currentColor）。`.btn svg` に width/height 明示（§5.3 の 0px 潰れ対策）。**絵文字を UI 要素にしない**。
- トークン: Spira `tokens.css`（モスグリーン accent / paper 系）を `web/app.css` 先頭に同梱。
  hex/px 直書き禁止、ガターは単一 `--gutter`。ダークは `[data-theme="dark"]`。
- 設定ハブ: §20 master-detail。データ場所等のサーバ設定は env、UI に出すのは接続先ポート/テーマのみ（§18）。

## 5. PowerShell サーバ エンドポイント（§18 準拠）

prefix `http://127.0.0.1:<QAM_RELAY_PORT>/`。全レスポンスに CORS、全リクエスト 1 行ログ。

| メソッド/パス | 役割 |
|---|---|
| `GET /qam/health` | 起動確認（launcher が待機） |
| `GET /`・`GET /qam/app.{js,css}` | UI 配信 |
| `GET /qam/current?entity=` | 現況 JSON |
| `GET /qam/history?entity=&from=&to=&q=` | 履歴（粗く絞り、細かいフィルタはクライアント） |
| `POST /qam/ingest` | XML 受領→パース→差分→（ガード OK なら）コミット、サマリ返却 |
| `POST /qam/ingest/confirm` | ガード時のステージ済み取込を確定 |
| `GET /qam/comments?entity=`・`POST /qam/comment` | コメント取得/追記 |
| `POST /qam/shutdown` | 「終了」アイコン（サーバ停止） |
| `GET/POST /qam/config` | データディレクトリ等の照会/変更 |

## 6. ファイル構成（§1 / §2）

```
qam/
  server/ qam-server.ps1 / qam-ingest.ps1 / qam-diff.ps1 / qam-store.ps1 / qam.env.example
  web/    index.html / app.css(tokens 同梱) / app.js / icons.js   （増えたら web/views/ に分割）
  qam-start.bat   （ASCII のみ・末尾 pause）          ← §18
  qam-start.ps1   （UTF-8 with BOM）                  ← §18 文字化け防止
  docs/DESIGN.md  README.md
```

1 ファイル 500 行 / 1 関数 80 行を上限。超えたらその変更内で分割。

## 7. 規約適用チェック（着手・完了時に参照）

- [ ] トークン直書きなし（CSS 変数のみ）/ inline style なし / ガター単一変数
- [ ] Enter ハンドラに IME ガード（isComposing || keyCode 229）
- [ ] アイコンは Feather・SVG に width/height 明示・絵文字不使用
- [ ] テーブル sticky ヘッダ不透明・行 hover/selected 規約色
- [ ] モーダルは固定サイズ + mousedown 起点の backdrop 判定 / 送信成功まで閉じない
- [ ] `.ps1` は UTF-8 with BOM / `.bat` は ASCII + 末尾 pause
- [ ] HttpListener prefix は `http://127.0.0.1:<port>/`
- [ ] 秘密情報・外部組織の固有名をコード/コミットに書かない
- [ ] getComputedStyle で実ピクセル確認してから「完了」と言う（§0）

## 8. 未確定事項（着手前に確定）

1. **AssetGroup のメンバ差分粒度**: IP 範囲集合 / 所属ホスト ID 単位 / 両方。
   → `current/group.json` の持ち方が変わる。
2. **コメント付与単位**: 変更イベント単位 / 資産 ID 単位 / 両方。
