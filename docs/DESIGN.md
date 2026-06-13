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

対象 API: `/api/2.0/fo/asset/group/?action=list`（`show_attributes=ALL`）/
`/api/2.0/fo/asset/host/?action=list`（`details=All`）/ `/api/2.0/fo/asset/domain/?action=list`。
**XML の正典構造とフィールドマッピングは [QUALYS_XML.md](QUALYS_XML.md)**（パーサはこれに準拠）。
Host 一覧は 1000 件超で末尾 `<WARNING><URL>`（`id_min` 付き次バッチ）が入る（Phase 4 の API 直叩きで follow）。

## 2. ストレージ

`<QAM_DATA_DIR>/` 配下（README 記載のレイアウト）。DB は使わずファイル。

```
snapshots/ group/<date>.json host/<date>.json domain/<date>.json  日次フル状態（保存期間内）
history/   group.jsonl host.jsonl domain.jsonl                     改廃イベント（永続・剪定しない）
comments/  comments.jsonl                                          作業履歴コメント（永続）
runs.jsonl                                                         取込メタ
raw/<date>/{group,host,domain}.xml.gz                              生XML（保存期間内）
```

- 日次フルスナップショット（`snapshots/<entity>/<date>.json` = キー→正規化レコードの辞書）を
  保存期間内だけ保持。**指定日の資産状況参照**と**現況表示**の元、かつ**差分の相手**。
- **保存期間（日）は設定画面から変更可能**（`/qam/config`）。期間超過の `snapshots/*/<date>` と
  `raw/<date>` を剪定。`history/` `comments/` は剪定しない（恒久記録）。
- 「現況」= 最新日付のスナップショット。`current/` ディレクトリは設けず最新日付で解決（重複回避）。

### 同一性キー
| エンティティ | キー | 備考 |
|---|---|---|
| AssetGroup | `ID` | 安定 |
| Host | `ID`（Qualys Host ID） | IP/DNS は変わるのでキーにしない |
| Domain | ドメイン文字列 | Qualys のドメインに ID は無い |

### 履歴イベント（`history/<entity>.jsonl` 1 行）
スカラー項目（old/new）:
```json
{"eid":"host:12345:2026-06-13:DNS","ts":"2026-06-13","entity":"host",
 "id":"12345","name":"web01","change":"modified","field":"DNS",
 "old":"web01.old","new":"web01.new"}
```
リスト/集合項目（added/removed。AssetGroup の IPS・DNS_LIST 等）:
```json
{"eid":"group:42:2026-06-13:IPS","ts":"2026-06-13","entity":"group",
 "id":"42","name":"Prod","change":"modified","field":"IPS",
 "added":["10.0.0.9"],"removed":["10.0.0.5"]}
```
- `change` = `added | modified | deleted`。資産自体の追加/削除は field 空。
- `eid` = `<entity>:<id>:<ts>:<field>` の安定キー（行の重複排除/参照用。コメントは資産単位で別管理）。

### 追跡フィールド（差分対象）
| エンティティ | スカラー | リスト/集合 |
|---|---|---|
| AssetGroup | TITLE, OWNER_ID, LAST_UPDATE(参考), BUSINESS_IMPACT | **IPS（IP+IP_RANGE）, DNS_LIST**, NETBIOS_LIST, DOMAIN_LIST, HOST_IDS(属性指定時) |
| Host | IP, DNS/FQDN, NETBIOS, OS, TRACKING_METHOD, LAST_VULN_SCAN_DATETIME | （所属 AssetGroup は参考情報） |
| Domain | DOMAIN_ID, NETWORK_NAME（DOMAIN_NAME=キー） | NETBLOCK(START-END) |

リスト/集合項目は**メンバの追加/削除**として `added`/`removed` で表現する。

### 現況（`current/<entity>.json`）
キー（ID/ドメイン）→ 正規化レコードの辞書。差分の相手かつ「資産一覧」表示の元。

### コメント（`comments/comments.jsonl` 1 行）— 資産単位の作業履歴
```json
{"ts":"2026-06-13T09:00:00Z","entity":"host","id":"12345",
 "author":"<user>","text":"改廃申請 #123 に基づき DNS 変更を確認"}
```
- 付与単位は **資産（`entity` + `id`）**。1 資産に時系列で複数コメントが付き、その資産の作業履歴になる。
- 改廃作業時の記入動線: **変更履歴ビューの改廃行 → その資産のコメントスレッドを開いて追記**。
  資産一覧ビューの行からも同じスレッドを開ける。`asof` 参照の集合キー（`<entity>:<id>`）で突合表示。

### 取込メタ（`runs.jsonl`）
`{ "ts", "entity", "count", "added", "modified", "deleted", "completed" }`

## 3. 差分エンジン（`qam-diff.ps1`）

1. 各レコードを正規化し `content_hash` を算出。日次スナップショット `snapshots/<entity>/<date>.json` を保存。
2. 直前のスナップショット（取込日より前で最大日付）と突合:
   - 新規キー → `added`
   - hash 変化 → `modified`（フィールド単位の差分を展開）
   - 消失キー → `deleted`
   - hash 同一 → 何も追記しない（履歴行を増やさない）
3. 変更を `history/<entity>.jsonl` に追記、`runs.jsonl` 追記。
4. 保存期間超過の `snapshots/*/<date>` と `raw/<date>` を剪定（`history/` `comments/` は対象外）。

### 指定日参照（point-in-time）
- 「資産一覧」ビューは as-of 日付を指定可能。`snapshots/<entity>/` から **指定日以前で最大日付**の
  スナップショットを読んで表示。
- 指定日が保存期間より前でスナップショットが無い場合は「保存期間外」を明示し、変更履歴ビューへ誘導。

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

- 左ペイン: モード切替「資産一覧 / 変更履歴」＋絞り込み。active は左ボーダー＋`accent-soft`。
- **資産一覧ビューの subbar に as-of 日付ピッカー**（既定=最新）。指定日以前で最大日付のスナップショットを表示。
  保存期間外の日付選択時は Empty 状態（§11）で「保存期間外・変更履歴で確認」を案内。
- タブ: エンティティ（AssetGroup/Host/Domain）。§23。
- 変更履歴の列: `日付 | 種別 | ID | 名前 | 項目 | 変更前/削除 | 変更後/追加 | コメント`。
  スカラーは old→new、リスト型は −removed / +added を表示。
  種別タグ色 added=`--ok` / modified=`--warn` / deleted=`--danger`。ID/タグは mono。
  コメント列は件数インジケータ、クリックでその資産の作業履歴スレッド（追記可）を開く。
- フィルタ: 期間（date input）・資産名・IP・FQDN・種別。
  **Enter を拾う全ハンドラに `if (e.isComposing || e.keyCode === 229) return;`（§6）**。
- コメント: §6.3 の textarea＋右下送信ボタン型。§8「送信成功までモーダルを閉じない」。成功時 §9 右上トースト。
- アイコン: Feather（stroke 1.7, 24x24 viewBox, currentColor）。`.btn svg` に width/height 明示（§5.3 の 0px 潰れ対策）。**絵文字を UI 要素にしない**。
- トークン: Spira `tokens.css`（モスグリーン accent / paper 系）を `web/app.css` 先頭に同梱。
  hex/px 直書き禁止、ガターは単一 `--gutter`。ダークは `[data-theme="dark"]`。
- 設定ハブ: §20 master-detail。起動系（待受ポート）は env、UI に出すのは接続先ポート/テーマのみ（§18）。
  ただし**運用設定の「保存期間（日）」は設定画面で変更可能**にし、`GET/POST /qam/config` 経由で
  PowerShell が `qam.env`（`QAM_RAW_RETENTION_DAYS`）へ永続化（bundle-dir を UI から変更可能にする §18 の前例に倣う）。
  保存期間変更時は次回取込で剪定が効く（即時剪定はしない＝誤設定での即消失を避ける）。

## 5. PowerShell サーバ エンドポイント（§18 準拠）

prefix `http://127.0.0.1:<QAM_RELAY_PORT>/`。全レスポンスに CORS、全リクエスト 1 行ログ。

| メソッド/パス | 役割 |
|---|---|
| `GET /qam/health` | 起動確認（launcher が待機） |
| `GET /`・`GET /qam/app.{js,css}` | UI 配信 |
| `GET /qam/current?entity=&asof=<date>` | 指定日（既定=最新）のフル状態 JSON。指定日以前で最大日付を返す |
| `GET /qam/dates?entity=` | スナップショットが存在する日付一覧（日付ピッカー用） |
| `GET /qam/history?entity=&from=&to=&q=` | 履歴（粗く絞り、細かいフィルタはクライアント） |
| `POST /qam/ingest` | XML 受領→パース→差分→（ガード OK なら）コミット、サマリ返却 |
| `POST /qam/ingest/confirm` | ガード時のステージ済み取込を確定 |
| `GET /qam/comments?entity=&id=`・`POST /qam/comment` | 資産単位コメント取得/追記（body: entity, id, text） |
| `POST /qam/shutdown` | 「終了」アイコン（サーバ停止） |
| `GET/POST /qam/config` | データディレクトリ・**保存期間（日）**等の照会/変更（env へ永続化） |

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

## 8. 確定事項（2026-06-13）

1. **AssetGroup のメンバ差分**: IPS（IP+範囲）と DNS_LIST の増減を差分対象に含める
   （＋ NETBIOS_LIST / DOMAIN_LIST / HOST_IDS）。リスト型は added/removed で表現。
2. **コメント付与単位**: **資産（entity+id）単位の作業履歴**。改廃行から改廃作業時に追記。
