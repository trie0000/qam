// 「人が足す記録」（メモ・注釈・操作履歴・簡易検査の管理表・ライセンス推移）の入出力。
//
// これらは Qualys から取り込むデータと違い、**複数人が同時に足す・直す**。
// ファイル(JSONL)実装では追記が「読む→足す→全文書き戻す」になり、SPO 上では
// ロストアップデートの温床になる（docs/SPO-MULTIUSER.md §3.1）。そこで
// SharePoint リスト実装に差し替えられるよう、ここでインタフェースを切っておく。
//   - 追記 → リストへの POST（SPO が採番するので競合しない）
//   - 更新 → MERGE + If-Match（412 なら読み直して再適用）
//
// スナップショット・改廃履歴・生XML は不変か追記専用なので、従来どおり FileBackend
// （ローカル or SharePoint ライブラリ）のままでよい。
import { backend } from '../relay';
import {
  readComments, addComment, editComment,
  readAnnotations, setAnnotation, setAnnotationsBulk,
  readOps, logOp, readManualInspections, appendManualInspection,
  readLicenses, recordLicense,
  type FileBackend, type QamLicenseSample, type QamManualInspection, type QamOp,
} from '../store';
import type { QamComment, QamEntity } from '../types';

export interface AnnotationUpdate { id: string; field: string; value: string }

/** 取込の排他クレーム。保持者と、いつから・いつまでを持つ。 */
export interface IngestLock { owner: string; since: string; expiresAt: string }

export interface RecordRepo {
  readComments(e?: QamEntity, id?: string): Promise<QamComment[]>;
  addComment(c: QamComment): Promise<void>;
  /** 本文の編集。entity + id + ts で 1 件を同定する。 */
  editComment(e: QamEntity, id: string, ts: string, text: string): Promise<void>;

  /** entity ごとの注釈: { [資産id]: { [項目]: 値 } }。 */
  readAnnotations(e: QamEntity): Promise<Record<string, Record<string, string>>>;
  setAnnotation(e: QamEntity, id: string, field: string, value: string): Promise<void>;
  setAnnotationsBulk(e: QamEntity, updates: AnnotationUpdate[]): Promise<void>;

  readOps(): Promise<QamOp[]>;
  logOp(op: QamOp): Promise<void>;

  readManualInspections(): Promise<QamManualInspection[]>;
  appendManualInspection(m: QamManualInspection): Promise<void>;

  readLicenses(): Promise<QamLicenseSample[]>;
  recordLicense(ts: string, ips: number, scanned: number): Promise<void>;

  /**
   * 取込の排他。取れたら null、他の人が取込中ならその保持者を返す。
   * 全員が取り込む運用なので、防ぎたいのはデータ破損ではなく**重複取込**
   * （同一イベントの二重記録・スナップショット二重作成・Qualys の二重取得）。
   * ブラウザを閉じたまま放置されても詰まらないよう TTL で自動失効させる。
   */
  acquireIngestLock(owner: string, ttlMin: number): Promise<IngestLock | null>;
  releaseIngestLock(owner: string): Promise<void>;
}

// 実体は起動時に決まる（SharePoint リスト）。呼び出し側は `repo` を使い続けられるよう委譲にする。
// ★既定は「未初期化なら例外」。黙って動く実装を既定にすると、保管先に繋がらないまま
//   別の場所へ書いてしまう。ただし releaseIngestLock だけは後片付けなので握り潰す。
const notReady = (): never => { throw new Error('保管先が未初期化です（SharePoint への接続に失敗しています）'); };
let impl: RecordRepo = {
  readComments: notReady, addComment: notReady, editComment: notReady,
  readAnnotations: notReady, setAnnotation: notReady, setAnnotationsBulk: notReady,
  readOps: notReady, logOp: notReady,
  readManualInspections: notReady, appendManualInspection: notReady,
  readLicenses: notReady, recordLicense: notReady,
  acquireIngestLock: notReady, releaseIngestLock: async () => undefined,
};
export const setRepo = (r: RecordRepo): void => { impl = r; };
export const repo: RecordRepo = {
  readComments: (e, id) => impl.readComments(e, id),
  addComment: (c) => impl.addComment(c),
  editComment: (e, id, ts, text) => impl.editComment(e, id, ts, text),
  readAnnotations: (e) => impl.readAnnotations(e),
  setAnnotation: (e, id, f, v) => impl.setAnnotation(e, id, f, v),
  setAnnotationsBulk: (e, u) => impl.setAnnotationsBulk(e, u),
  readOps: () => impl.readOps(),
  logOp: (op) => impl.logOp(op),
  readManualInspections: () => impl.readManualInspections(),
  appendManualInspection: (m) => impl.appendManualInspection(m),
  readLicenses: () => impl.readLicenses(),
  recordLicense: (ts, ips, scanned) => impl.recordLicense(ts, ips, scanned),
  acquireIngestLock: (owner, ttlMin) => impl.acquireIngestLock(owner, ttlMin),
  releaseIngestLock: (owner) => impl.releaseIngestLock(owner),
};
