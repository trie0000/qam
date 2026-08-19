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
import type { RasAsset, RasPerms, RasTicket } from '../ras';
import type { SiteGroup } from './sp/perms';

export interface AnnotationUpdate { id: string; field: string; value: string }

/** 取込の排他クレーム。保持者と、いつから・いつまでを持つ。 */
export interface IngestLock { owner: string; since: string; expiresAt: string }

/** アイテム単位権限を付け直す相手。 */
export interface PermTarget { id: number; businessCompany: string }
export interface RasPermTargets { assets?: PermTarget[]; tickets?: PermTarget[] }
/**
 * 同期の結果。
 * ★permTargets = **新しく作った行**と**事業会社が変わった行**。
 *   ここにアクセス権を付け直さないと、増えた行が誰にも（あるいは誰にでも）見える。
 */
export interface RasSyncResult {
  added: number; updated: number; removed: number;
  permTargets: PermTarget[];
}

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

  // --- 独自RAS ---
  /** 共有設定に置く任意の JSON（事業会社マスター＋アクセス権の割当）。 */
  readSharedJson<T>(key: string, fallback: T): Promise<T>;
  writeSharedJson(key: string, value: unknown): Promise<void>;

  readRasAssets(): Promise<RasAsset[]>;
  /** 取込で作った資産一覧を反映する（登録済みの会社は呼び出し側が引き継いで渡す）。 */
  syncRasAssets(assets: RasAsset[]): Promise<RasSyncResult>;
  /** 渡した資産だけを反映する（載っていない行は消さない）。選択同期で使う。 */
  syncRasAssetsPartial(assets: RasAsset[]): Promise<RasSyncResult>;
  /** key は RasAsset.key（ホストID、または host list に無い資産の 'ip:<IP>'）。 */
  setRasCompany(key: string, businessCompany: string, managementCompany: string): Promise<void>;
  /** CSV取込用の一括更新。1件ずつ setRasCompany を呼ぶと毎回全件読み直しになるため分ける。 */
  setRasCompaniesBulk(updates: { key: string; businessCompany: string; managementCompany: string }[]): Promise<number>;
  /** RAS資産のメモ（複数行）。 */
  setRasAssetNote(key: string, note: string): Promise<void>;

  readRasTickets(): Promise<RasTicket[]>;
  syncRasTickets(tickets: RasTicket[]): Promise<RasSyncResult>;
  /** 日次更新の結果（変化ラベル・レポートリンク）を書き戻す。 */
  setRasTicketMarks(marks: { number: string; change?: string; changedAt?: string; reportJa?: string; reportEn?: string; ticketReportJa?: string; ticketReportEn?: string; reportZip?: string; reportedAt?: string; note?: string }[]): Promise<number>;

  /** 独自RASの2リストを SharePoint で開くURL。取れなければ空文字。 */
  rasListUrls(): Promise<{ assets: string; tickets: string }>;
  /** サイトの権限グループ（アクセス権画面の選択肢）。 */
  listSiteGroups(): Promise<SiteGroup[]>;
  /** 2リストの全アイテムへアクセス権を適用する。進捗は onProgress に返す。 */
  applyRasPerms(perms: RasPerms, onProgress?: (done: number, total: number) => void): Promise<{ items: number }>;
  /** 指定したアイテムにだけアクセス権を付け直す（同期で増えた/会社が変わった行のため）。 */
  applyRasPermsFor(perms: RasPerms, targets: RasPermTargets, onProgress?: (done: number, total: number) => void): Promise<{ items: number }>;
}

// 実体は起動時に決まる（SharePoint リスト）。呼び出し側は `repo` を使い続けられるよう委譲にする。
// ★既定は「未初期化なら例外」。黙って動く実装を既定にすると、保管先に繋がらないまま
//   別の場所へ書いてしまう。ただし releaseIngestLock だけは後片付けなので握り潰す。
const notReady = (): never => { throw new Error('保管先が未初期化です（SharePoint への接続に失敗しています）'); };
let impl: RecordRepo = {
  readComments: notReady, addComment: notReady, editComment: notReady,
  readAnnotations: notReady, setAnnotation: notReady, setAnnotationsBulk: notReady,
  readSharedJson: notReady, writeSharedJson: notReady,
  readRasAssets: notReady, syncRasAssets: notReady, syncRasAssetsPartial: notReady, setRasCompany: notReady, setRasCompaniesBulk: notReady, setRasAssetNote: notReady,
  readRasTickets: notReady, syncRasTickets: notReady, setRasTicketMarks: notReady,
  rasListUrls: notReady, listSiteGroups: notReady, applyRasPerms: notReady, applyRasPermsFor: notReady,
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
  readSharedJson: (k, f) => impl.readSharedJson(k, f),
  writeSharedJson: (k, v) => impl.writeSharedJson(k, v),
  readRasAssets: () => impl.readRasAssets(),
  syncRasAssets: (a) => impl.syncRasAssets(a),
  syncRasAssetsPartial: (a) => impl.syncRasAssetsPartial(a),
  setRasCompany: (k, b, m) => impl.setRasCompany(k, b, m),
  setRasCompaniesBulk: (u) => impl.setRasCompaniesBulk(u),
  setRasAssetNote: (k, n) => impl.setRasAssetNote(k, n),
  readRasTickets: () => impl.readRasTickets(),
  syncRasTickets: (t) => impl.syncRasTickets(t),
  setRasTicketMarks: (m) => impl.setRasTicketMarks(m),
  rasListUrls: () => impl.rasListUrls(),
  listSiteGroups: () => impl.listSiteGroups(),
  applyRasPerms: (p, cb) => impl.applyRasPerms(p, cb),
  applyRasPermsFor: (p, t, cb) => impl.applyRasPermsFor(p, t, cb),
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
