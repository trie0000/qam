// ストレージ層: snapshots/history/comments/runs の read/write・asof 解決・剪定・取込確定。
// 実ファイル IO は FileBackend（relay 実装 or テストのインメモリ）に委譲する。
import type { QamComment, QamEntity, QamEvent, QamRecords, QamSnapshot } from './types';
import { compareSnapshots, countByChange, shrinkGuard } from './diff';

// QAM_DATA_DIR からの相対パスで read/write/list/remove する抽象。
export interface FileBackend {
  read(path: string): Promise<string | null>;
  write(path: string, content: string, append?: boolean): Promise<void>;
  list(dir: string): Promise<string[]>; // 直下のファイル/ディレクトリ名
  remove(path: string): Promise<void>; // ファイル or ディレクトリ
}

const ENTITIES: QamEntity[] = ['group', 'host', 'domain'];
const snapPath = (e: QamEntity, d: string) => `snapshots/${e}/${d}.json`;
const histPath = (e: QamEntity) => `history/${e}.jsonl`;
const COMMENTS = 'comments/comments.jsonl';
const RUNS = 'runs.jsonl';

// --- snapshots ---
export async function getSnapshotDates(b: FileBackend, e: QamEntity): Promise<string[]> {
  const names = await b.list(`snapshots/${e}`);
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
}

export function resolveAsof(dates: string[], asof?: string): string | null {
  if (dates.length === 0) return null;
  if (!asof) return dates[dates.length - 1];
  const le = dates.filter((d) => d <= asof);
  return le.length ? le[le.length - 1] : null;
}

function prevDateOf(dates: string[], date: string): string | null {
  const lt = dates.filter((d) => d < date);
  return lt.length ? lt[lt.length - 1] : null;
}

export async function readSnapshot(b: FileBackend, e: QamEntity, date: string): Promise<QamSnapshot | null> {
  const raw = await b.read(snapPath(e, date));
  return raw ? (JSON.parse(raw) as QamSnapshot) : null;
}

const writeSnapshot = (b: FileBackend, s: QamSnapshot, date: string) =>
  b.write(snapPath(s.entity, date), JSON.stringify({ entity: s.entity, datetime: s.datetime, records: s.records }));

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

// 冪等な再取込: 指定日のイベントを除去してから追記し直す。
async function removeHistoryForDate(b: FileBackend, e: QamEntity, date: string): Promise<void> {
  const all = await readJsonl<QamEvent>(b, histPath(e));
  const kept = all.filter((ev) => ev.ts !== date);
  if (kept.length !== all.length) await b.write(histPath(e), kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''));
}

// --- comments（資産単位） ---
export const addComment = (b: FileBackend, c: QamComment) =>
  b.write(COMMENTS, JSON.stringify(c) + '\n', true);

export async function readComments(b: FileBackend, e?: QamEntity, id?: string): Promise<QamComment[]> {
  const all = await readJsonl<QamComment>(b, COMMENTS);
  return all.filter((c) => (!e || c.entity === e) && (!id || c.id === id));
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
    for (const d of await getSnapshotDates(b, e)) {
      if (d < cutoff) { await b.remove(snapPath(e, d)); removed.push(`${e}/${d}`); }
    }
  }
  for (const d of await b.list('raw')) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) { await b.remove(`raw/${d}`); removed.push(`raw/${d}`); }
  }
  return removed;
}

// --- 取込確定 ---
export interface IngestOptions {
  date?: string;
  today: string;
  guardRatio: number;
  retentionDays: number;
  force?: boolean;
  rawXml?: string;
}
export interface IngestResult {
  entity: QamEntity; date: string; prevCount: number; currCount: number;
  baseline: boolean; guard: boolean; committed: boolean;
  added: number; modified: number; deleted: number; pruned: number;
}

export async function ingestSnapshot(b: FileBackend, snap: QamSnapshot, opts: IngestOptions): Promise<IngestResult> {
  const { entity, records } = snap;
  const dates = await getSnapshotDates(b, entity);
  const date = opts.date || resolveDate(snap.datetime, opts.today);
  const currCount = Object.keys(records).length;
  const pDate = prevDateOf(dates, date);
  const prev: QamRecords | null = pDate ? (await readSnapshot(b, entity, pDate))?.records ?? null : null;
  const prevCount = prev ? Object.keys(prev).length : 0;
  const baseline = !pDate;
  const guard = shrinkGuard(prevCount, currCount, opts.guardRatio);
  const res: IngestResult = { entity, date, prevCount, currCount, baseline, guard, committed: false, added: 0, modified: 0, deleted: 0, pruned: 0 };
  if (guard && !opts.force) return res;

  await writeSnapshot(b, snap, date);
  const events = baseline ? [] : compareSnapshots(prev, records, entity, date);
  await removeHistoryForDate(b, entity, date);
  await appendHistory(b, entity, events);
  res.added = countByChange(events, 'added');
  res.modified = countByChange(events, 'modified');
  res.deleted = countByChange(events, 'deleted');
  await b.write(RUNS, JSON.stringify({ ts: date, entity, count: currCount, added: res.added, modified: res.modified, deleted: res.deleted, completed: true }) + '\n', true);
  if (opts.rawXml) await b.write(`raw/${date}/${entity}.xml`, opts.rawXml);
  res.pruned = (await prune(b, opts.retentionDays, opts.today)).length;
  res.committed = true;
  return res;
}

// XML DATETIME → yyyy-MM-dd（無ければ today）。parse 側と同等だがここでも使えるよう内包。
function resolveDate(datetime: string, today: string): string {
  if (datetime) {
    const d = new Date(datetime);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return today;
}
