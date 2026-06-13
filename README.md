# QAM — Qualys Asset Management

Qualys VMDR の **AssetGroup / Host / Domain** の登録状況と、その**改廃履歴（追加・変更・削除）**を
ローカルで参照・記録するツール。

- 取り込み：**Qualys API から直接ダウンロード**（プロキシ経由）／一覧 **XML アップロード**の両方
- 差分：前回スナップショットと比較し、**変更だけ**を履歴として蓄積
- 参照：ブラウザ UI（現在の登録状況 / 変更履歴の一覧・フィルタ・Spira 準拠テーブル）
- 記録：**資産単位の作業履歴コメント**を付与（改廃作業時に改廃行から追記）

## アーキテクチャ（TS アプリ + 薄い PowerShell relay）

memola / Spira と同じ構成。**アプリ本体は TypeScript（ブラウザ、esbuild バンドル）**、
**PowerShell は薄い relay**（配信＋プロキシ取得＋ファイル IO）に徹する。配布先 Windows に
追加インストール不要（PowerShell は標準搭載、Node はビルド時のみ）。

```
[qam-start.bat ダブルクリック]
  └→ qam-relay.ps1 が http://127.0.0.1:<port>/ を起動（管理者権限不要・PS 5.1）
       └→ 既定ブラウザで開く → TSバンドル(qam.bundle.js)を配信

  ブラウザ(TS) … XMLパース / 差分計算 / 表示 / フィルタ / テーブル
       │  GET/POST http://127.0.0.1:<port>
       ▼
  qam-relay.ps1（薄い中継・PS 5.1）
       ├ /qam/fetch   : Qualys API を「プロキシ経由 + Basic認証」で取得（CORS/プロキシ回避）
       ├ /qam/file    : UNC 共有のファイル read/write/list（ブラウザが書けない部分）
       └ /qam/bundle  : TSバンドル配信・version
```

ブラウザは UNC への書き込みもプロキシ経由アクセスもできないため relay は必須だが、**重い/変わりやすい
ロジックは全部 TS** に置き、relay は I/O とプロキシ取得だけの最小実装にする。データは UNC 共有
（`QAM_DATA_DIR`）に集約。

### Qualys API ダウンロード（プロキシ経由）
- 接続先 POD・**アカウント/パスワード**・**プロキシ URL** は**設定画面**から登録（既定値は env）。
- relay が `System.Net.Http.HttpClient` + `WebProxy` で Qualys へ（corp GW 参照と同方式）。
  Host 一覧の `WARNING/URL`（`id_min`）ページングは relay 側で follow。
- **認証情報は env かブラウザ設定（localStorage）で保持し、コード/リポジトリには置かない。**

## データ配置（DB なし＝ファイル）

プログラムとデータは分離（データ場所は env）。**指定日の資産状況を表示**できるよう
日次フルスナップショットを保存期間内だけ保持し、**改廃履歴とコメントは永続**で持つ。

```
<QAM_DATA_DIR>/
  snapshots/ group/<date>.json host/<date>.json domain/<date>.json  日次フル状態（保存期間内・現況/指定日参照）
  history/   group.jsonl host.jsonl domain.jsonl                     改廃イベント（追記のみ・永続）
  comments/  comments.jsonl                                          作業履歴コメント（追記のみ・永続）
  runs.jsonl                                                         取込メタ（日付/件数/completed）
  raw/<date>/{group,host,domain}.xml.gz                              生XML（保存期間内）
```

- 同一性キー：AssetGroup=`ID` / Host=`ID`（IP・DNS はキーにしない）/ Domain=ドメイン文字列。
- **保存期間（日）は設定画面から変更可能**。期間を過ぎた `snapshots/*/<date>` と `raw/<date>` を剪定する。
- **改廃履歴 `history/` とコメント `comments/` は剪定しない**（嵩張らず、これが恒久記録）。
- **指定日の資産状況** = その日（無ければ直前）のスナップショットを表示。保存期間より前の日付は
  スナップショットが無いため、改廃履歴ビューで変化を追う。

## 起動・設定

```
1) server/qam.env.example を qam.env にコピーして QAM_DATA_DIR 等を設定
2) qam-start.bat をダブルクリック
3) 開いたブラウザで利用。終了は UI の「終了」アイコン
```

設定は env に一元化（優先順位：引数 > プロセス環境変数 > `qam.env`）。
**API キー等の秘密情報は env のみに置き、リポジトリには絶対に置かない。**

## ロードマップ（フェーズ規律：着手前にここへ記載する）

- [ ] **Phase 1** — TS アプリ基盤 + relay（配信/ファイル IO/プロキシ取得）+ 差分エンジン(TS) +
      変更履歴/資産一覧ビュー（**指定日参照**・Spira 準拠テーブル）+ フィルタ + 設定画面
      （Qualys 認証・プロキシ・**保存期間**）+ **Qualys API ダウンロード**＋XML アップロード両対応
- [ ] **Phase 2** — 作業履歴コメント（資産単位・relay 経由で共有へ書込）
- [ ] **Phase 3** — CSV / Excel エクスポート

> 言語：アプリ本体 = TypeScript（esbuild / vitest）、relay・launcher = PowerShell 5.1 準拠。

## 設計

詳細は [docs/DESIGN.md](docs/DESIGN.md)。UI は Spira デザインルール（トークン準拠・トースト/モーダル必須・
絵文字アイコン禁止）に従う。

## 規約

- UI：トークン直書き禁止（CSS 変数のみ）、inline style 禁止、Enter ハンドラは IME 変換中を除外。
- コード：1 ファイル 500 行 / 1 関数 80 行を上限。責務ごとにファイル分割。
- ランタイム依存ゼロ（ブラウザ標準 API / PowerShell 標準のみ）。
- **外部組織の固有情報をコード・コメント・コミットに書かない。** URL/テナント等はプレースホルダか env。
