// QAM 共通型。parse/diff/store/UI で共有する。

export type QamEntity = 'group' | 'host' | 'domain' | 'user';
export type QamChange = 'added' | 'modified' | 'deleted';

// 1 資産の正規化レコード。scalar/set が差分対象、info は表示用（差分しない）。
export interface QamRecord {
  key: string;
  name: string;
  scalar: Record<string, string>;
  set: Record<string, string[]>;
  info: Record<string, string>;
  hash: string;
}

export type QamRecords = Record<string, QamRecord>;

export interface QamSnapshot {
  entity: QamEntity;
  datetime: string; // XML の RESPONSE/DATETIME（あれば）
  records: QamRecords;
}

// 改廃イベント（history jsonl の 1 行）。
//   scalar 変更 → old/new、set 変更 → added/removed、資産自体の追加/削除 → field なし。
export interface QamEvent {
  eid: string;
  ts: string; // 更新日。API差分は XML上の更新時刻(AssetGroup=LAST_UPDATE等)、無ければ取込スタンプ。
  ingestStamp?: string; // 取込スタンプ（同一取込の上書き判定に使う。ts と別管理）。
  entity: QamEntity;
  id: string;
  name: string;
  change: QamChange;
  field?: string;
  old?: string;
  new?: string;
  added?: string[];
  removed?: string[];
  // その変更を行った時点の資産プロパティ（フィールドキー→値）。最新ではなく point-in-time のスナップショット。
  //   added: 追加後の値 / deleted: 削除直前の値 / modified: 変更後(curr)の値。
  props?: { k: string; v: string }[];
  // modified の変更前(prev)プロパティ。変更前/変更後の2カラム表示に使う。
  propsOld?: { k: string; v: string }[];
}

// 四半期検査ビューが使う Qualys 応答の生 XML（取得時点のキャッシュ）。
// 実施済み/スケジュールの scan・map を 1 セットで保持し、再取得なしで再描画できるようにする。
export interface QamInspectionRaw {
  scans: string;
  maps: string;
  scanSchedules: string;
  mapSchedules: string;
  fetchedAt: string; // ISO
}

// 資産単位の作業履歴コメント。
export interface QamComment {
  ts: string;
  entity: QamEntity;
  id: string;
  author: string;
  text: string;
}

// 修復チケット（Qualys /msp/ticket_list.php の 1 件）。
// 資産(QamRecord)と違い差分・改廃履歴は取らない（状態が頻繁に変わるので取込時点の一覧として持つ）。
export interface QamTicket {
  number: string;   // チケットID（TICKET/NUMBER）
  state: string;    // ステータス（CURRENT_STATE: OPEN/RESOLVED/CLOSED/IGNORED）
  hostId: string;   // ホストID（DETECTION/HOST_ID。show_host_id=1 のときだけ入る）
  ip: string;       // DETECTION/IP
  fqdn: string;     // DETECTION/FQDN（無ければ DNSNAME）
  created: string;    // チケットオープン日時（CREATION_DATETIME・UTC）
  firstFound: string; // 初回検知日時（STATS/FIRST_FOUND_DATETIME・UTC）
  lastFound: string;  // 最終検知日時（STATS/LAST_FOUND_DATETIME・UTC）
  cves?: string[];    // VULNINFO の CVE 番号（show_vuln_details=1 のときだけ入る。旧スナップショットには無い）
}

// チケット一覧のスナップショット（取込 1 回分）。
export interface QamTicketSnapshot {
  fetchedAt: string;   // 取得時刻(ISO)
  mode: 'delta' | 'open'; // delta=直近1ヶ月の変化分 / open=オープン中を全件
  since: string;       // modified_since_datetime に渡した値（open のときは空）
  states: string;      // states パラメータに渡した値
  tickets: QamTicket[];
}
