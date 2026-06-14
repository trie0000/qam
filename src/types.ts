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
  ts: string; // yyyy-MM-dd
  entity: QamEntity;
  id: string;
  name: string;
  change: QamChange;
  field?: string;
  old?: string;
  new?: string;
  added?: string[];
  removed?: string[];
  // 削除イベント時、削除直前の資産プロパティ（フィールドキー→値）。表示用スナップショット。
  props?: { k: string; v: string }[];
}

// 資産単位の作業履歴コメント。
export interface QamComment {
  ts: string;
  entity: QamEntity;
  id: string;
  author: string;
  text: string;
}
