// ストレージ層: snapshots/history/comments/runs の read/write・asof 解決・剪定・取込確定。
// スナップショットは「取込日時(stamp)」ごとに保持（同日複数回の取込を別ポイントとして残す）。
//   stamp = 'YYYY-MM-DDTHH-mm-ss'（ファイル名/キー/辞書順ソート可）。
// 実ファイル IO は FileBackend（relay 実装 or テストのインメモリ）に委譲する。
import type { QamComment, QamEntity, QamEvent, QamRecords, QamSnapshot } from './types';
import { compareSnapshots, countByChange, shrinkGuard } from './diff';

export interface FileBackend {
  read(path: string): Promise<string | null>;
  write(path: string, content: string, append?: boolean): Promise<void>;
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

const ENTITIES: QamEntity[] = ['group', 'host', 'domain', 'user'];
const snapPath = (e: QamEntity, stamp: string) => `snapshots/${e}/${stamp}.json`;
const histPath = (e: QamEntity) => `history/${e}.jsonl`;
const COMMENTS = 'comments/comments.jsonl';
const RUNS = 'runs.jsonl';

export const dateOfStamp = (stamp: string): string => stamp.slice(0, 10);

// --- snapshots ---
export async function getSnapshotStamps(b: FileBackend, e: QamEntity): Promise<string[]> {
  const names = await b.list(`snapshots/${e}`);
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
}

// 指定 asof 以前で最大の stamp（未指定なら最新）。該当無しは null。
export function resolveAsof(stamps: string[], asof?: string): string | null {
  if (stamps.length === 0) return null;
  if (!asof) return stamps[stamps.length - 1];
  const le = stamps.filter((s) => s <= asof);
  return le.length ? le[le.length - 1] : null;
}

function prevStampOf(stamps: string[], stamp: string): string | null {
  const lt = stamps.filter((s) => s < stamp);
  return lt.length ? lt[lt.length - 1] : null;
}

export async function readSnapshot(b: FileBackend, e: QamEntity, stamp: string): Promise<QamSnapshot | null> {
  const raw = await b.read(snapPath(e, stamp));
  return raw ? (JSON.parse(raw) as QamSnapshot) : null;
}

const writeSnapshot = (b: FileBackend, s: QamSnapshot, stamp: string) =>
  b.write(snapPath(s.entity, stamp), JSON.stringify({ entity: s.entity, datetime: s.datetime, records: s.records }));

// --- history ---
async function readJsonl<T>(b: FileBackend, path: string): Promise<T[]> {
  const raw = await b.read(path);
  if (!raw) return [];
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export async function readHistory(b: FileBackend, e: QamEntity, from?: string, to?: string): Promise<QamEvent[]> {
  const all = await readJsonl<QamEvent>(b, histPath(e));
  return all.filter((ev) => (!from || ev.ts >= from) && (!to || ev.ts <= to));
}

const appendHistory = (b: FileBackend, e: QamEntity, events: QamEvent[]) =>
  events.length ? b.write(histPath(e), events.map((x) => JSON.stringify(x)).join('\n') + '\n', true) : Promise.resolve();

// 既存の変更履歴を取り込む（CSV 由来など）。eid 重複は除いて追記し、追記件数を返す。
// onProgress: 重複除外後の追記対象件数(total)に対し、書き込み済み件数(done)を逐次通知（進捗表示用）。
export async function importHistory(b: FileBackend, e: QamEntity, events: QamEvent[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const seen = new Set((await readJsonl<QamEvent>(b, histPath(e))).map((x) => x.eid));
  const fresh = events.filter((x) => !seen.has(x.eid));
  const total = fresh.length;
  const BATCH = 1000; // 大量行は分割追記し、バッチごとに進捗を通知
  for (let i = 0; i < total; i += BATCH) {
    const chunk = fresh.slice(i, i + BATCH);
    await b.write(histPath(e), chunk.map((x) => JSON.stringify(x)).join('\n') + '\n', true);
    onProgress?.(Math.min(i + BATCH, total), total);
  }
  return total;
}

// 同じ取込日時(stamp)の履歴を除去（同 stamp の再取込＝上書き、手動削除に使う）。
async function removeHistoryForStamp(b: FileBackend, e: QamEntity, stamp: string): Promise<void> {
  const all = await readJsonl<QamEvent>(b, histPath(e));
  // 取込スタンプで判定（ts は XML更新時刻になり得るため）。旧データは ingestStamp 未設定なので ts にフォールバック。
  const kept = all.filter((ev) => (ev.ingestStamp ?? ev.ts) !== stamp);
  if (kept.length !== all.length) await b.write(histPath(e), kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''));
}

// 変更履歴の手動削除: 指定 eid のイベントを history から除去。削除件数を返す。
export async function removeHistoryEvents(b: FileBackend, e: QamEntity, eids: string[]): Promise<number> {
  const set = new Set(eids);
  const all = await readJsonl<QamEvent>(b, histPath(e));
  const kept = all.filter((ev) => !set.has(ev.eid));
  const removed = all.length - kept.length;
  if (removed) await b.write(histPath(e), kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''));
  return removed;
}

// スナップショット手動削除: 当該 stamp の snapshot・履歴・raw を消す（前後の点は残る）。
export async function deleteSnapshot(b: FileBackend, e: QamEntity, stamp: string): Promise<void> {
  await b.remove(snapPath(e, stamp));
  await removeHistoryForStamp(b, e, stamp);
  await b.remove(`raw/${dateOfStamp(stamp)}/${e}-${stamp}.xml`); // 無ければ no-op
}

// --- データのリセット（開発者向け）: 種類を選んで全削除。何を消すかは呼び出し側で選択。 ---
//   snapshots: スナップショット(資産データ)＋raw＋取込メタ / history: 変更履歴 / comments: メモ(コメント)
export interface ResetOptions { snapshots?: boolean; history?: boolean; comments?: boolean }
export async function resetData(b: FileBackend, opts: ResetOptions): Promise<void> {
  if (opts.snapshots) {
    for (const e of ENTITIES) for (const s of await getSnapshotStamps(b, e)) await b.remove(snapPath(e, s));
    await b.remove(RUNS);
    await b.remove('licenses.jsonl'); // ライセンス数推移サンプルも資産データの一部として消去
    for (const d of await b.list('raw')) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) await b.remove(`raw/${d}`);
  }
  if (opts.history) for (const e of ENTITIES) await b.remove(histPath(e));
  if (opts.comments) await b.remove(COMMENTS);
}

// --- ライセンス推移: 取込stampごとに記録（剪定対象外で長期保持） ---
//   ips     = IPs in Subscription（Qualys の /asset/ip 一覧から数えた登録IP総数。取得不可なら 0）
//   scanned = Unique Hosts Scanned（host 一覧から算出した、スキャン済みの一意ホスト数）
export interface QamLicenseSample { ts: string; ips: number; scanned: number }
const LICENSES = 'licenses.jsonl';
export const recordLicense = (b: FileBackend, ts: string, ips: number, scanned: number): Promise<void> =>
  b.write(LICENSES, JSON.stringify({ ts, ips, scanned }) + '\n', true);
export async function readLicenses(b: FileBackend): Promise<QamLicenseSample[]> {
  // 旧形式 {ts,count}（=一意IP）も含めて正規化。同一 ts は後勝ち（ips を後から埋めるケースに対応）。
  const rows = await readJsonl<{ ts: string; count?: number; ips?: number; scanned?: number }>(b, LICENSES);
  const map = new Map<string, QamLicenseSample>();
  for (const r of rows) {
    const cur = map.get(r.ts);
    map.set(r.ts, { ts: r.ts, ips: Math.max(cur?.ips ?? 0, r.ips ?? 0), scanned: r.scanned ?? r.count ?? cur?.scanned ?? 0 });
  }
  return [...map.values()];
}

// --- 操作履歴（監査ログ）: 登録/削除/変更などの操作を 作業者・日時つきで記録 ---
export interface QamOp { ts: string; author: string; action: string; entity?: QamEntity; detail: string }
const OPS = 'ops.jsonl';
export const logOp = (b: FileBackend, op: QamOp): Promise<void> => b.write(OPS, JSON.stringify(op) + '\n', true);
export const readOps = (b: FileBackend): Promise<QamOp[]> => readJsonl<QamOp>(b, OPS);

// --- 手動メタ情報（注釈）: API で取れない項目を一覧から手入力する（Function/Location 等） ---
// entity ごとに 1 ファイル。{ [id]: { [field]: value } }。Qualys スナップショット/差分とは独立。
const annotPath = (e: QamEntity) => `annotations/${e}.json`;
export async function readAnnotations(b: FileBackend, e: QamEntity): Promise<Record<string, Record<string, string>>> {
  const raw = await b.read(annotPath(e));
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, Record<string, string>>; } catch { return {}; }
}
export async function setAnnotation(b: FileBackend, e: QamEntity, id: string, field: string, value: string): Promise<void> {
  const all = await readAnnotations(b, e);
  applyAnnot(all, id, field, value);
  await b.write(annotPath(e), JSON.stringify(all));
}

function applyAnnot(all: Record<string, Record<string, string>>, id: string, field: string, value: string): void {
  const rec = all[id] ?? {};
  if (value) rec[field] = value; else delete rec[field];
  if (Object.keys(rec).length) all[id] = rec; else delete all[id];
}

// 複数注釈をまとめて適用（CSV一括取込用）。全体を1回だけ読み、メモリ上で更新して1回だけ書き込む。
// 1項目ごとに read+write していた従来方式（R行×F項目の往復）の遅さを解消する。
export async function setAnnotationsBulk(b: FileBackend, e: QamEntity, updates: { id: string; field: string; value: string }[]): Promise<void> {
  if (!updates.length) return;
  const all = await readAnnotations(b, e);
  for (const u of updates) applyAnnot(all, u.id, u.field, u.value);
  await b.write(annotPath(e), JSON.stringify(all));
}

// --- comments（資産単位） ---
export const addComment = (b: FileBackend, c: QamComment) => b.write(COMMENTS, JSON.stringify(c) + '\n', true);

export async function readComments(b: FileBackend, e?: QamEntity, id?: string): Promise<QamComment[]> {
  const all = await readJsonl<QamComment>(b, COMMENTS);
  return all.filter((c) => (!e || c.entity === e) && (!id || c.id === id));
}

// 既存コメントの本文を編集（entity+id+ts で同定）。
export async function editComment(b: FileBackend, e: QamEntity, id: string, ts: string, text: string): Promise<void> {
  const all = await readJsonl<QamComment>(b, COMMENTS);
  let done = false;
  const out = all.map((c) => (!done && c.entity === e && c.id === id && c.ts === ts ? (done = true, { ...c, text }) : c));
  if (done) await b.write(COMMENTS, out.map((x) => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''));
}

// --- 取込メタ（取込日時ごと） ---
export interface QamRun { ts: string; entity: QamEntity; count: number; added: number; modified: number; deleted: number; baseline: boolean }
export async function readRuns(b: FileBackend, e?: QamEntity): Promise<QamRun[]> {
  const all = await readJsonl<QamRun>(b, RUNS);
  return e ? all.filter((r) => r.entity === e) : all;
}

// --- prune（保存期間超過の snapshots/raw を削除。history/comments は対象外） ---
function cutoffDate(refDate: string, retentionDays: number): string {
  const d = new Date(refDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - retentionDays);
  return d.toISOString().slice(0, 10);
}

export async function prune(b: FileBackend, retentionDays: number, refDate: string): Promise<string[]> {
  if (retentionDays <= 0) return [];
  const cutoff = cutoffDate(refDate, retentionDays);
  const removed: string[] = [];
  for (const e of ENTITIES) {
    for (const s of await getSnapshotStamps(b, e)) {
      if (dateOfStamp(s) < cutoff) { await b.remove(snapPath(e, s)); removed.push(`${e}/${s}`); }
    }
  }
  for (const d of await b.list('raw')) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) { await b.remove(`raw/${d}`); removed.push(`raw/${d}`); }
  }
  return removed;
}

// --- バックアップ（データディレクトリ全体の定期退避・復元） ---
// バックアップ実体は backups/<slot>.zip（データディレクトリ全体を圧縮したもの。raw/backups/ログ/設定は除外）。
// zip 化・展開はファイルの所在地である relay 側で行う（relay.ts の backupNow/restoreNow）。
// store 側は slot 計算・一覧・保管期間の剪定だけを担う（FileBackend だけで完結＝単体テスト可能）。
const pad2 = (n: number): string => String(n).padStart(2, '0');

// 保存間隔(分)で丸めたローカル時刻を 'YYYY-MM-DDTHH-mm-ss' で返す。同一スロットは同名＝重複退避を防ぐ。
export function backupSlot(date: Date, intervalMin: number): string {
  const ms = Math.max(1, intervalMin) * 60000;
  const d = new Date(Math.floor(date.getTime() / ms) * ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

// 既存バックアップの slot 一覧（新しい順）。backups/<slot>.zip の .zip を除いた名前。
export async function listBackups(b: FileBackend): Promise<string[]> {
  return (await b.list('backups'))
    .filter((n) => /^\d{4}-\d{2}-\d{2}T.*\.zip$/.test(n))
    .map((n) => n.replace(/\.zip$/, ''))
    .sort().reverse();
}
export const hasBackup = async (b: FileBackend, slot: string): Promise<boolean> =>
  (await listBackups(b)).includes(slot);

// 保管日数を超えた古いバックアップ(zip)を削除。削除した slot を返す。
export async function pruneBackups(b: FileBackend, retentionDays: number, refDate: string): Promise<string[]> {
  if (retentionDays <= 0) return [];
  const cutoff = cutoffDate(refDate, retentionDays);
  const removed: string[] = [];
  for (const slot of await listBackups(b)) {
    if (slot.slice(0, 10) < cutoff) { await b.remove(`backups/${slot}.zip`); removed.push(slot); }
  }
  return removed;
}

// --- 取込確定（取込日時 stamp ごとに 1 スナップショット。直前取込との差分を履歴へ） ---
export interface IngestOptions { stamp: string; guardRatio: number; retentionDays: number; force?: boolean; rawXml?: string }
export interface IngestResult {
  entity: QamEntity; stamp: string; prevCount: number; currCount: number;
  baseline: boolean; guard: boolean; committed: boolean;
  added: number; modified: number; deleted: number; pruned: number;
}

export async function ingestSnapshot(b: FileBackend, snap: QamSnapshot, opts: IngestOptions): Promise<IngestResult> {
  const { entity, records } = snap;
  const stamp = opts.stamp;
  const stamps = await getSnapshotStamps(b, entity);
  const currCount = Object.keys(records).length;
  const pStamp = prevStampOf(stamps, stamp);
  const prev: QamRecords | null = pStamp ? (await readSnapshot(b, entity, pStamp))?.records ?? null : null;
  const prevCount = prev ? Object.keys(prev).length : 0;
  const baseline = !pStamp;
  const guard = shrinkGuard(prevCount, currCount, opts.guardRatio);
  const res: IngestResult = { entity, stamp, prevCount, currCount, baseline, guard, committed: false, added: 0, modified: 0, deleted: 0, pruned: 0 };
  if (guard && !opts.force) return res;

  await writeSnapshot(b, snap, stamp);
  // 各取込は独立した点。直前取込との差分を、その取込日時(stamp)で履歴へ。
  // 同 stamp の再取込（上書き）に備え、まず当該 stamp の履歴を除去してから追記する。
  const events = baseline ? [] : compareSnapshots(prev, records, entity, stamp);
  await removeHistoryForStamp(b, entity, stamp);
  await appendHistory(b, entity, events);
  res.added = countByChange(events, 'added');
  res.modified = countByChange(events, 'modified');
  res.deleted = countByChange(events, 'deleted');
  await b.write(RUNS, JSON.stringify({ ts: stamp, entity, count: currCount, added: res.added, modified: res.modified, deleted: res.deleted, baseline }) + '\n', true);
  if (opts.rawXml) await b.write(`raw/${dateOfStamp(stamp)}/${entity}-${stamp}.xml`, opts.rawXml);
  res.pruned = (await prune(b, opts.retentionDays, dateOfStamp(stamp))).length;
  res.committed = true;
  return res;
}
