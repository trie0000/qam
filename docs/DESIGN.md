# QAM 詳細設計

対象: Qualys VMDR の AssetGroup / Host / Domain の登録状況と改廃履歴。
UI は Spira デザインルール（全アプリ共通）/ 開発基準（bookmarklet アプリ共通）に準拠。
本ツールは **bookmarklet 型ではないローカル単体ツール**のため、SP オリジン関連規約
（all:initial シールド、ローダ 2MB 制限、SP REST 書込みの罠）は非該当。
ローカルリレー作法（127.0.0.1 / env / health / 1 行ログ）と UI 規約は全面適用。

**実装言語/構成（memola/Spira と同じ）:** アプリ本体は **TypeScript**（ブラウザ、esbuild バンドル、
vitest）。**PowerShell 5.1 は薄い relay**（バンドル配信 / Qualys のプロキシ取得 / UNC ファイル IO）に
徹する。ブラウザが UNC 書込み・プロキシアクセス・クロスオリジンをできないため relay は必須だが、
パース・差分・状態・表示など重い/変わりやすいロジックは全部 TS 側に置く。

## 1. 取り込み（ingestion）

2 経路を同一の TS 正規化関数に合流させる（UI・差分は取り込み元に依存しない）:
- **API ダウンロード**: ブラウザ → relay `/qam/fetch` → relay が **プロキシ経由 + Basic 認証**で
  Qualys を取得し XML を返す → ブラウザ(TS)がパース。接続先 POD・アカウント/パスワード・
  プロキシ URL は設定画面（既定は env）。Host の `WARNING/URL`（`id_min`）ページングは relay が follow。
- **XML アップロード**: ブラウザでファイル選択 → TS がそのままパース（relay 不要）。

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
- 一覧表（資産一覧・変更履歴とも）は **Notion §25「共通テーブル設計」準拠**：行/全件選択チェックボックス、
  列幅リサイズ・列入れ替え（pointer 自前実装）、ソート、列幅/順序の localStorage 永続化、選択時バルクバー常設。
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
- TopBar 「取込」: **Qualys API ダウンロード**（kind 選択→relay 経由取得）と **XML アップロード**の両入口。
- 設定ハブ: §20 master-detail。項目=**Qualys 接続先 POD / アカウント / パスワード / プロキシ URL / 保存期間（日）**
  ＋接続先ポート/テーマ。既定値は env、設定画面の変更は `POST /qam/config` で `qam.env` へ永続化。
  パスワードはブラウザ設定(localStorage)保持を既定とし、env 直書きは非推奨。
  保存期間変更時は次回取込で剪定（即時剪定はしない＝誤設定での即消失を避ける）。

## 5. relay エンドポイント（薄い中継・§18 準拠・PS 5.1）

prefix `http://127.0.0.1:<QAM_RELAY_PORT>/`。全レスポンスに CORS、全リクエスト 1 行ログ。
relay は I/O とプロキシ取得のみ。**パース/差分/ストレージ書式の解釈は TS 側**が持つ。

| メソッド/パス | 役割 |
|---|---|
| `GET /qam/health` | 起動確認（launcher が待機） |
| `GET /`・`GET /qam/bundle/*` | TS バンドル(qam.bundle.js)・version・静的配信 |
| `POST /qam/fetch` | Qualys API を**プロキシ + Basic 認証**で取得し XML を返す（body: kind, base, user, pass, proxy）。Host ページングを follow |
| `GET /qam/file?path=` | UNC データ配下のファイル読込（path は `QAM_DATA_DIR` 配下に限定） |
| `POST /qam/file` | ファイル書込（body: path, content）。append フラグで jsonl 追記 |
| `GET /qam/file/list?dir=` | ディレクトリ一覧（スナップショット日付列挙等） |
| `GET/POST /qam/config` | 既定値（プロキシ/POD/保存期間）の照会・変更（env へ永続化） |
| `POST /qam/shutdown` | 「終了」アイコン（relay 停止） |

ストレージのレイアウト（snapshots/history/comments）と差分・剪定・asof 解決・件数急減ガードは
**TS 側のロジック**で、`/qam/file` 越しに read/write する。relay はパス安全性（データ配下限定）だけ担保。

## 6. ファイル構成（§1 / §2）

```
qam/
  src/                      ← TS アプリ本体（esbuild で qam.bundle.js に）
    main.ts                 起動・state・イベント結線
    config.ts               定数・localStorage キー・relay 接続先
    relay.ts                relay クライアント（fetch/file/list/config ラッパ）
    ingest/parse.ts         Qualys XML → 正規化レコード（QUALYS_XML.md 準拠）
    diff.ts                 差分エンジン(added/modified/deleted, set added/removed)
    store.ts                snapshots/history/comments の read/write（relay 経由）+ asof/剪定
    qualys.ts               API ダウンロード（kind 別パラメータ組立）
    icons.ts                Feather SVG
    styles/app.css          Spira トークン同梱 + コンポーネント
    ui/                     table.ts（共通テーブル §25）/ modal.ts / toast.ts / views/*
  server/
    qam-relay.ps1           薄い relay（配信/プロキシ取得/ファイルIO・PS 5.1）
    qam.env.example
  qam-start.bat             （ASCII のみ・末尾 pause）        ← §18
  qam-start.ps1             （UTF-8 with BOM）                ← §18 文字化け防止
  build.js  package.json  tsconfig.json  vitest.config.ts
  test/*.test.ts            vitest（parse/diff/store）
  docs/DESIGN.md  QUALYS_XML.md  README.md
```

1 ファイル 500 行 / 1 関数 80 行を上限。テーブルは Notion §25「共通テーブル設計」準拠。

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

## 7.5 四半期検査（SCAN/MAP の四半期充足チェック）

「四半期に一度は SCAN / MAP 検査を実施する」運用ルールの充足を可視化する。判定ロジックは
`src/inspection.ts`（純粋関数・vitest 対象）、XML パースは `src/inspection-parse.ts`、
描画は `src/ui/views/inspection.ts`（ライセンス推移と同じダッシュボード型のカスタム DOM）。

- **母集団**: 最新の AssetGroup スナップショットから **`settenId`（config.ts・タイトル先頭〜最初の半角
  スペース）で接続点ID を切り出し**、それが対象パターン（既定 `^[A-Z]{2}[0-9]{3,4}D?$`・設定で変更可）に
  一致するもの。**判定も一覧も接続点ID 単位**（同一 ID の AG は束ね、元タイトルは `titles` に保持）。
  Qualys 応答が返す AssetGroup タイトルも突合前に接続点ID へ揃える。**再取得はしない**。
- **SCAN 対象条件**: `isScanEligible(id, ips)` = 接続点ID が `D` 終わり、または `set.IPS` が非空。
  D 終わりは動的運用で IP を登録しないため対象に残す。同一接続点に複数 AG があるときは
  1 つでも条件を満たせば対象。外れたものは `scanExcluded` に理由付きで残し UI に出す。
- **MAP 対象**: 上記接続点の `set.DOMAIN_LIST` に登録されたドメイン。**空なら MAP 対象外**。
  MAP の判定は SCAN 対象可否と独立（SCAN 対象外でもドメインがあれば MAP 対象）。
- **判定**: 四半期内に完了実施あり → 検査済み / 四半期内に次回実行予定がある有効スケジュールあり →
  スケジュール済み / どちらも無い → 未対応。四半期は年度開始月（既定 4）基準。
- **取得**: `qualys.ts downloadInspection` が 4 本を**順次**取得（relay は単スレッドのため並列にしない）。
  **スキャンは v2、マップは v1(MSP)**（v2 にマップ系エンドポイントは存在せず 404。詳細は QUALYS_XML.md）。
  1 本失敗しても他は活かし、失敗したものは警告として UI に出す（全滅時のみ例外）。
- **保存**: 結果の生 XML を `inspection/<日付>.json` に**取込日ごと**へ保存（同日再取得は上書き＝日単位）。
  UI の「取込日」で過去分を参照でき、母集団の AssetGroup もその日以前の最新スナップショットを使う。
  生 XML のまま持つので設定変更（対象パターン・年度開始月）が過去分にも遡って効く。
  保存期間を過ぎたものは `prune` で剪定。日次化前の `inspection/latest.json` は読み込みのみ互換対応。
- **既知の制約**: 実施済みマップは「保存されたマップレポート」しか取れない（`save_report` 無しで実行した
  マップは一覧に出ない）。マップが未対応に偏る場合はまずこれを疑う。
- **設定**: `fiscalStartMonth` / `inspectionAgPattern` を relay `/qam/config`（env）へ永続化。

## 7.6 スケジュール登録（作成のみ・Qualys への書き込み）

- **組立/検証**: `src/schedule.ts`（純粋関数）。SCAN=v2 / MAP=v1 で表記差（`active` が `0/1` と
  `yes/no`、曜日の大小、対象キー `asset_groups` / `scan_target`、プロファイルキー `option_title` /
  `option`）を内部表現から変換する。空値の項目は送らない（Qualys が不正パラメータとして弾くため）。
- **送信**: relay `POST /qam/qualys/schedule-add` が form-urlencoded で POST。
  **送信先は `/api/2.0/fo/schedule/scan/` と `/msp/scheduled_scans.php` の 2 つに限定**
  （任意 URL への書き込みを受け付けない）。
- **成否判定**: `scheduleResult`。v1 は `<RETURN status>`、v2 は `<CODE>` の有無で判定し、
  Qualys の `<TEXT>` をそのまま利用者に見せる（HTTP 200 でも本文がエラーのことがある）。
- **既定値**: オプションプロファイル（SCAN/MAP 別）・スキャナー（既定 External）・タイムゾーン（既定 JP）を
  共通設定（relay `/qam/config`）に持つ。登録画面の初期値になり、種別を切り替えると
  プロファイルの既定値も追従する（利用者が書き換えた値は上書きしない）。
- **安全策**: 送信前に `describeSchedule` の要約で確認モーダル → 成功まで入力モーダルを閉じない →
  成功時は操作履歴に記録。作成時の状態は既定「無効」。更新・削除は実装しない（Qualys 画面で行う）。
- **監査ログ（必須）**: 更新系 API は relay の `Add-QamAudit` で `api-audit.log` に
  「実行者・メソッド・URL・パラメータ・結果」を出力する。実行者はブラウザから `author` として渡す。
  認証情報は絶対に含めない。参照系（fetch）は対象外で、従来どおり relay.log に残す。

## 7.65 簡易検査（AssetGroup / ドメインの払い出し＋検査登録）

`src/provision.ts`（純粋関数）が命名と組立を持つ。

- **命名**: AssetGroup = `申請番号(仮)`、ドメイン = `toDnsLabel(申請番号).地域コード`。
  `(仮)`・全角・記号は DNS 名に使えないため `toDnsLabel` で英数字とハイフンへ落とす（1ラベル63文字）。
- **地域区分**: 既定 6 区分（jp/na/la/eu/in/cn）。共通設定 `regions`（`ラベル=コード` のカンマ区切り）で
  変更可。不正行は捨て、全滅なら既定へ戻す。フォームでは**既定を未選択にして常時表示**し、
  `validateProvision` が **MAP 対象があるときだけ必須**にする（MAP 用ドメイン名の末尾に使うため）。
- **検証の順序**: `validateProvision` にエラーがある間は `validateSchedule` を出さない。
  スケジュール側の対象は plan から導出されるので、同時に出すと「地域区分が未選択」に対して
  「対象のドメインを入力してください」のような派生エラーが並び、原因が分かりにくくなる。
- **検査資産情報の入力**: テキスト欄に直接入力し「追加」でトークン配列へ積む（`ProvisionInput.ips` は
  正規化済み文字列の配列）。`parseIpInput` / `parseFqdnInput` がカンマ分割・トリミング・書式判定を行い、
  `{tokens, errors}` を返す。区切りは**カンマ・改行(CR/LF)・タブ**（表計算からの貼り付けを想定）。
  入力欄は textarea で、素の Enter は改行・追加は Ctrl/⌘+Enter とボタン（IME 変換中は無視）。errors が1つでもあれば UI は何も追加せず警告のみ（入力は残して修正を促す）。
  IP は `classifyIpToken` で single/cidr/range を判別。レンジの `-` は両端の半角スペースを許容し
  `normalizeIpToken` で詰める。**レンジは展開せず表記のまま 1 件**として `ips` へカンマ連結する。
- **Qualys の制約**: AssetGroup 名は**一意必須**・`All` 不可。ドメインは `www.` を付けない。
- **登録順**: AssetGroup 作成 → （MAP のとき）ドメイン登録 → スケジュール登録。**同名は更新**で扱う
  （`findAssetGroup` → `buildAssetGroupEditParams` の `action=edit&id=…&add_ips|add_dns_names`、
  `findDomain` → `mergeNetblocks` で既存＋今回分を `action=edit&netblock=…`）。
  edit は `set_*` が上書き・ドメインの `netblock` も送った内容が正になるため、**既存を消さない足し方**に
  統一する。追加分が無いドメインは更新自体を行わない。途中失敗時は完了済みの手順を添えて返す。
- **登録前チェック** (`precheck.ts`): 取り込み済みスナップショット（group/domain/host の最新）から
  `buildRegistry` でインデックスを作り、`checkAsset` が資産ごとに `new | known | unknown` と
  トラッキング方式の食い違い（`ip-tracked-fqdn` / `dns-tracked-ip`）を判定する。静的は `ipBounds` の
  範囲照合（CIDR・レンジは範囲内の既存ホストを全部拾う）、動的は FQDN/DNS 名の完全一致（小文字化）。
  host 未取込は `unknown`＝「判定不可」で、**新規と誤って断定しない**。表示は `assetBadge` /
  `issueLines` / `existingNameLines`（いずれも純粋関数でテスト対象）。UI 側は `ui/views/asset-editor.ts`
  がバッジと「新規登録される見込み」を描画し、`conflicts()` が SCAN 対象の食い違いを返す。
  食い違いがある場合、フォームは `confirmTracking` を呼び、**「検査担当に確認済み」チェックが入るまで
  送信を通さない**（main.ts のモーダル側で primary を弾く）。
- **relay の許可パス**: schedule/scan・scheduled_scans.php・asset/group・asset_domain.php の 4 つのみ。
- **名前解決の検証** (`/qam/resolve`): ブラウザから DNS は引けないので relay が代行する。外部コマンド
  (nslookup) は起動せず `[System.Net.Dns]::GetHostAddressesAsync` を使う（引数を渡さないので注入の
  余地がなく、PS5.1/7・OS 差も吸収できる）。relay は単スレッドなので **1 件ごとに 4 秒でタイムアウト**し、
  **1 リクエスト 100 件まで**。名前は FQDN 書式に一致するものだけ引き、結果は relay.log にも残す。
  UI 側は行ごとに `unknown | checking | ok | ng` を保持し、SCAN 対象に ok 以外があれば登録前に確認する
  （トラッキング食い違いと違いチェックは課さない。公開前で解決できない、が正当な運用のため）。
- **検査種別は資産ごと**: `AssetEntry { value, scan, map }` を持ち、MAP 対象は **domains**
  （申請番号ベースのドメイン1件＋対象IPを `netblock` に）、SCAN 対象は AssetGroup の `ips`/`dns_names`
  へ登録する。`planProvision` が scanTargets / mapTargets / domains / netblocks を導出する。
  全選択チェックは行の状態に追従する。
- **動的は MAP 対象外**: `planProvision` が `assetType === 'dynamic'` のとき mapTargets を空にする
  （UI で MAP チェックを無効化するのに加え、モデル側でも落とす）。古い履歴からのプリフィルに備え、
  `validateProvision` は動的＋MAP をエラーにし、`asset-editor` の `add()` も map を落とす。
- **表示順は MAP → SCAN**: 運用の実施順に合わせ、資産行のチェック・スケジュール欄・
  オプションプロファイル・`describeProvision` の確認内容・登録手順（スケジュール作成と管理表記録）を
  すべて MAP 先行で揃える。「同じタイミング」は**先に入力する MAP を基準に SCAN が追従**し、
  片方だけ実施する場合は同期しない（未使用側の値で上書きしないため）。
- **スケジュールタイトル**: `scheduleTitle(agTitle, kind, ymd)` = `AG名_s_YYYYMMDD` / `AG名_m_YYYYMMDD`。
- **検査予定日時**: SCAN/MAP で別に保持。「同じタイミング」チェック時は MAP が SCAN に追従する。
- **資産種別**: 静的（IP 指定）= 検査資産情報は IP のみ。
  IP は **プライベートIP（RFC1918）を拒否**（`containsPrivateIp`。単体・CIDR のネットワークアドレス・
  レンジの両端すべてを見る）。動的では IP エディタを `setEnabled(false)` で無効化し、値も保持しない
  （隠すだけだと種別を戻したとき等に残ってしまうため）。
  動的（FQDN 指定）= SCAN 固定・MAP 不可、検査資産情報は FQDN のみ（DNS_LIST へ）。`effectiveKind` が
  動的を常に scan へ矯正し、planProvision がもう一方の入力を捨てる（意図しない登録を防ぐ）。
- **1回のみ実行**: スケジュールは周期を持たず「検査予定日＋開始時刻」だけ指定する。API 上は
  `occurrence=daily & frequency_days=1 & recurrence=1`（1回実行後に自動無効化。v1/v2 とも対応確認済み）。
  タイトル既定は `AssetGroup名_YYYYMMDD`（申請番号・予定日に追従、手編集後は上書きしない）。
- **登録モード**: `qualys`（実登録）/ `ledger`（管理表のみ）。ledger は Qualys API を呼ばず
  `inspection/manual.jsonl` に追記（恒久・剪定対象外）。読み出しはスケジュール行（source='manual'）に
  変換して computeInspection の manual 引数へ合流させる。検査一覧の状態は「管理表のみ」で区別する。
- **管理表（登録履歴）**: `inspection/manual.jsonl` に **両モードとも**記録する（mode='qualys'|'ledger'、
  provision=フォーム入力スナップショット）。判定へ合流させるのは mode≠'qualys'（ledger と旧データ）だけ
  （実登録分は取得スケジュールと二重計上になるため）。簡易検査ビューはこの管理表を共通テーブルで表示し、
  行クリックで provision をプリフィルして再登録できる（旧データはタイトル等から可能な範囲で復元）。
- **UI**: 左ペインの「簡易検査」＝管理表一覧。上部の「＋ 新規登録」で登録モーダルを開く。
  モーダルは `dismissBackdrop:false`（背景クリックで閉じない。キャンセル/×/Esc のみ）。Esc は
  モーダルスタックの最前面だけを閉じる（確認モーダルの Esc で下のフォームまで閉じない）。
  入力は 申請情報（申請番号/件名/申請部門・申請部門担当者/地域区分）→ 検査対象 → 検査スケジュール → その他（備考）
  のセクション構成。関連の深い項目は `pair()` で2段組（申請部門＋担当者／資産種別＋検査種別／
  検査予定日＋開始時刻）。flex:1 なので片方を hidden にすると残りが幅いっぱいに広がる
  （動的で検査種別を隠したときに資産種別が伸びる）。狭い画面では折り返して縦積みになる。申請部門は AG の division、件名・申請者・備考は comments へ記録。
  スキャナー/プロファイルは折りたたみ「オプション設定」に集約。フォームはモーダルではなくページ内に置く
  （`buildInspectionForm` が本体 node と submit を返す）。四半期検査の「新規検査登録」ボタンは
  このビューへ遷移するだけにして、登録 UI を一箇所に集約している。
- **注意（既知の落とし穴）**: `hidden` 属性は UA の `display:none` なので、`.qam-field` のように
  作者 CSS で `display:flex` を当てた要素には効かない。`[hidden] { display:none !important }` を
  共通で入れて、条件表示（IP の単体/レンジ、周期ごとの行、種別ごとの行）が確実に消えるようにしている。

## 7.7 検査一覧（実行履歴・予約済み）

`buildEntries` が実施済み scan/map とスケジュールを 1 つの行型 `InspEntry` に正規化する
（`category` が `run` / `schedule`）。日時降順で並べ、共通テーブルで表示。`category` 列で
絞り込めるので、実行履歴だけ・予約済みだけの一覧としても使える。対象からは `settenId` で
接続点ID を切り出して列に出す（対象と接続点の対応をその場で確認できるようにするため）。

## 8. 確定事項（2026-06-13）

1. **AssetGroup のメンバ差分**: IPS（IP+範囲）と DNS_LIST の増減を差分対象に含める
   （＋ NETBIOS_LIST / DOMAIN_LIST / HOST_IDS）。リスト型は added/removed で表現。
2. **コメント付与単位**: **資産（entity+id）単位の作業履歴**。改廃行から改廃作業時に追記。
