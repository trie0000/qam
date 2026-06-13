# QAM — Qualys Asset Management

Qualys VMDR の **AssetGroup / Host / Domain** の登録状況と、その**改廃履歴（追加・変更・削除）**を
ローカルで参照・記録するツール。

- 取り込み：Qualys から取得した一覧 **XML をアップロード**（将来は API 直叩きに置換）
- 差分：前回スナップショットと比較し、**変更だけ**を履歴として蓄積
- 参照：ブラウザ UI（現在の登録状況 / 変更履歴の一覧・フィルタ）
- 記録：変更に対する**作業履歴コメント**を付与

## アーキテクチャ（ローカル単体ツール）

```
[qam-start.bat ダブルクリック]
  └→ qam-server.ps1 が http://127.0.0.1:<port>/ を起動（管理者権限不要）
       └→ 既定ブラウザで http://127.0.0.1:<port>/ を開く

  ブラウザUI ──GET──▶ PowerShell : 現況/履歴/コメントを共有から読んで返す
  XMLアップロード ─POST▶ PowerShell : パース→差分→履歴更新（共有に書込）
  コメント入力   ─POST▶ PowerShell : コメント追記（共有に書込）
```

ファイルへの書き込みは **PowerShell が OS のファイル I/O で実施**するため、ブラウザのサンドボックス制約・
File System Access API・Microsoft Graph・SharePoint はいずれも不要。データは UNC 共有等の
ファイルサーバ（`QAM_DATA_DIR`）に集約する。

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

- [ ] **Phase 1** — XML アップロード取込 + 差分エンジン + 変更履歴ビュー + 資産一覧ビュー（**指定日参照**）
      + フィルタ + 設定画面（**保存期間の変更**・保存期間超過分の剪定）
- [ ] **Phase 2** — 作業履歴コメント（PowerShell 経由で共有へ書込）
- [ ] **Phase 3** — CSV / Excel エクスポート
- [ ] **Phase 4** — Qualys API 直叩き取込（手動 XML アップロードを置換）

## 設計

詳細は [docs/DESIGN.md](docs/DESIGN.md)。UI は Spira デザインルール（トークン準拠・トースト/モーダル必須・
絵文字アイコン禁止）に従う。

## 規約

- UI：トークン直書き禁止（CSS 変数のみ）、inline style 禁止、Enter ハンドラは IME 変換中を除外。
- コード：1 ファイル 500 行 / 1 関数 80 行を上限。責務ごとにファイル分割。
- ランタイム依存ゼロ（ブラウザ標準 API / PowerShell 標準のみ）。
- **外部組織の固有情報をコード・コメント・コミットに書かない。** URL/テナント等はプレースホルダか env。
