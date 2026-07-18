// 四半期 SCAN/MAP 検査コンプライアンス判定（純粋ロジック・UI/IO を持たない）。
//
// ルール:
//   - SCAN は AssetGroup 指定で実施。対象母集団は AG タイトルがパターンに一致するもの。
//   - MAP はドメイン指定で実施。対象は上記 AG に登録された DOMAIN_LIST のドメイン。
//     ドメイン未登録の AG は MAP 対象外。
//   - 「検査済み」= 現四半期内に完了した実施がある。
//   - 「スケジュール済み」= 現四半期内に次回実行予定があるアクティブなスケジュールがある。
//   - どちらも無ければ「未対応」。
import type { QamInspectionRaw, QamRecords } from './types';
import type { MapRun, MapScheduleRow, ScanRun, ScanScheduleRow } from './inspection-parse';
import { parseMapList, parseMapSchedules, parseScanList, parseScanSchedules } from './inspection-parse';

export type InspKind = 'scan' | 'map';
export type InspStatus = 'done' | 'scheduled' | 'pending';

export interface QuarterWeek { no: number; start: Date; end: Date; label: string }
export interface Quarter { fy: number; q: number; label: string; start: Date; end: Date; weeks: QuarterWeek[] }

// 検査対象 1 件。scan は key=AG タイトル、map は key=ドメイン（ags=そのドメインを登録している AG）。
export interface InspTarget { kind: InspKind; key: string; ags: string[] }
export interface InspRow extends InspTarget { status: InspStatus; doneAt: string; weekNo: number | null; nextLaunch: string }

export interface RunHit { key: string; datetime: string }
export interface SchedHit { key: string; nextLaunch: string; active: boolean }

// 接続点 ID 形式: 英字2文字 + 数字3〜4桁 + 末尾 D（任意）。
export const DEFAULT_AG_PATTERN = '^[A-Z]{2}[0-9]{3,4}D?$';

// 設定値の正規表現を安全にコンパイル（不正なら既定へフォールバック）。
export function agPattern(src: string): RegExp {
  try { return new RegExp(src || DEFAULT_AG_PATTERN, 'i'); }
  catch { return new RegExp(DEFAULT_AG_PATTERN, 'i'); }
}

const norm = (s: string): string => s.trim().toLowerCase();
const md = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()}`;

function toDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// 完了扱いにする状態。Qualys は Finished/Running/Canceled/Paused/Errors 等を返す。
// 状態が取れない版もあるので、空なら完了扱い（API 側で state=Finished を指定しているため）。
export function isFinished(state: string): boolean {
  const s = state.trim().toLowerCase();
  return !s || s.includes('finish');
}

// 四半期を 7 日刻みの週に分割（最終週は四半期末で打ち切り）。
function weeksOf(start: Date, end: Date): QuarterWeek[] {
  const weeks: QuarterWeek[] = [];
  let cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let no = 1;
  while (cur <= end) {
    const raw = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 6, 23, 59, 59, 999);
    const wEnd = raw > end ? end : raw;
    weeks.push({ no, start: new Date(cur), end: wEnd, label: `第${no}週 (${md(cur)}〜${md(wEnd)})` });
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
    no++;
  }
  return weeks;
}

// 指定時点が属する四半期。fiscalStartMonth=4 なら Q1=4-6 / Q2=7-9 / Q3=10-12 / Q4=1-3。
export function quarterOf(now: Date, fiscalStartMonth = 4): Quarter {
  const fs = Math.min(12, Math.max(1, Math.floor(fiscalStartMonth || 4))) - 1; // 0-based
  const monthsSince = (now.getMonth() - fs + 12) % 12;
  const start = new Date(now.getFullYear(), now.getMonth() - (monthsSince % 3), 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 0, 23, 59, 59, 999); // 3ヶ月目の末日
  const q = Math.floor(monthsSince / 3) + 1;
  // 年度 = 年度開始月を含む年（fs=3 なら 1-3 月は前年度）。
  const fy = start.getMonth() >= fs ? start.getFullYear() : start.getFullYear() - 1;
  return { fy, q, label: `${fy}年度 Q${q}`, start, end, weeks: weeksOf(start, end) };
}

// AssetGroup スナップショットから SCAN 対象 AG と MAP 対象ドメインを導出。
// DOMAIN_LIST が空の AG は MAP 対象に出さない（＝MAP 対象外）。
// skipped にはパターン不一致で対象外になったタイトルを残す（「なぜ出ないのか」を UI で示すため）。
export interface BuiltTargets { scan: InspTarget[]; map: InspTarget[]; total: number; skipped: string[] }
export function buildTargets(records: QamRecords, pattern: RegExp): BuiltTargets {
  const scan: InspTarget[] = [];
  const skipped: string[] = [];
  const domainAgs = new Map<string, string[]>();
  let total = 0;
  for (const r of Object.values(records)) {
    const title = (r.scalar.TITLE || r.name || '').trim();
    if (!title) continue;
    total++;
    if (!pattern.test(title)) { skipped.push(title); continue; }
    scan.push({ kind: 'scan', key: title, ags: [title] });
    for (const raw of r.set.DOMAIN_LIST ?? []) {
      const dom = norm(raw);
      if (!dom) continue;
      const ags = domainAgs.get(dom) ?? [];
      if (!ags.includes(title)) ags.push(title);
      domainAgs.set(dom, ags);
    }
  }
  scan.sort((a, b) => a.key.localeCompare(b.key));
  const map: InspTarget[] = [...domainAgs.entries()]
    .map(([key, ags]) => ({ kind: 'map' as const, key, ags: ags.sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { scan, map, total, skipped: skipped.sort() };
}

// 実施・スケジュールを「対象キー → ヒット」の形へ正規化する。
export function scanRunHits(runs: ScanRun[]): RunHit[] {
  const out: RunHit[] = [];
  for (const r of runs) {
    if (!isFinished(r.state)) continue;
    for (const ag of r.assetGroups) out.push({ key: ag, datetime: r.datetime });
  }
  return out;
}
export const mapRunHits = (runs: MapRun[]): RunHit[] =>
  runs.filter((m) => isFinished(m.state) && m.domain).map((m) => ({ key: m.domain, datetime: m.datetime }));

export function scanSchedHits(rows: ScanScheduleRow[]): SchedHit[] {
  const out: SchedHit[] = [];
  for (const s of rows) for (const ag of s.assetGroups) out.push({ key: ag, nextLaunch: s.nextLaunch, active: s.active });
  return out;
}
// 1 タスクが複数ドメインを対象にできるので、ドメインごとのヒットに展開する。
export const mapSchedHits = (rows: MapScheduleRow[]): SchedHit[] =>
  rows.flatMap((m) => m.domains.map((d) => ({ key: d, nextLaunch: m.nextLaunch, active: m.active })));

const weekNoOf = (d: Date, q: Quarter): number | null => q.weeks.find((w) => d >= w.start && d <= w.end)?.no ?? null;

// 対象ごとに 検査済み / スケジュール済み / 未対応 を判定する。
export function classify(targets: InspTarget[], runs: RunHit[], scheds: SchedHit[], q: Quarter): InspRow[] {
  const inQuarter = (iso: string): Date | null => {
    const d = toDate(iso);
    return d && d >= q.start && d <= q.end ? d : null;
  };
  const done = new Map<string, Date>(); // 四半期内の最新実施
  for (const r of runs) {
    const d = inQuarter(r.datetime);
    const k = norm(r.key);
    if (!d || !k) continue;
    const prev = done.get(k);
    if (!prev || d > prev) done.set(k, d);
  }
  const sched = new Map<string, Date>(); // 四半期内の直近予定
  for (const s of scheds) {
    if (!s.active) continue;
    const d = inQuarter(s.nextLaunch);
    const k = norm(s.key);
    if (!d || !k) continue;
    const prev = sched.get(k);
    if (!prev || d < prev) sched.set(k, d);
  }
  return targets.map((t) => {
    const k = norm(t.key);
    const hit = done.get(k);
    if (hit) return { ...t, status: 'done' as const, doneAt: hit.toISOString(), weekNo: weekNoOf(hit, q), nextLaunch: '' };
    const next = sched.get(k);
    if (next) return { ...t, status: 'scheduled' as const, doneAt: '', weekNo: null, nextLaunch: next.toISOString() };
    return { ...t, status: 'pending' as const, doneAt: '', weekNo: null, nextLaunch: '' };
  });
}

export interface StatusCounts { done: number; scheduled: number; pending: number; total: number }
export function countStatus(rows: InspRow[]): StatusCounts {
  const c: StatusCounts = { done: 0, scheduled: 0, pending: 0, total: rows.length };
  for (const r of rows) c[r.status]++;
  return c;
}

// 週次サマリ: その週に実施された件数と、四半期開始からの累計。
export interface WeekSummary { no: number; label: string; scanDone: number; mapDone: number; scanCum: number; mapCum: number }
export function weeklySummary(scan: InspRow[], map: InspRow[], q: Quarter): WeekSummary[] {
  let scanCum = 0;
  let mapCum = 0;
  return q.weeks.map((w) => {
    const s = scan.filter((r) => r.weekNo === w.no).length;
    const m = map.filter((r) => r.weekNo === w.no).length;
    scanCum += s;
    mapCum += m;
    return { no: w.no, label: w.label, scanDone: s, mapDone: m, scanCum, mapCum };
  });
}

// 未対応の AssetGroup 一覧。SCAN 未対応、または登録ドメインに 1 つでも未対応 MAP がある AG を挙げる。
export interface PendingAg { ag: string; scanPending: boolean; mapPendingDomains: string[] }
export function pendingAgs(scan: InspRow[], map: InspRow[]): PendingAg[] {
  const byAg = new Map<string, PendingAg>();
  const ensure = (ag: string): PendingAg => {
    const cur = byAg.get(ag) ?? { ag, scanPending: false, mapPendingDomains: [] };
    byAg.set(ag, cur);
    return cur;
  };
  for (const r of scan) if (r.status === 'pending') ensure(r.key).scanPending = true;
  for (const r of map) {
    if (r.status !== 'pending') continue;
    for (const ag of r.ags) ensure(ag).mapPendingDomains.push(r.key);
  }
  return [...byAg.values()].sort((a, b) => a.ag.localeCompare(b.ag));
}

// AssetGroup スナップショット + 取得済み生XML → ビューが表示する一式。
// raw が無い（未取得）ときは全件が「未対応」ではなく、実施/予定が空の状態として算出される。
// 応答から読めた件数と、対象に紐づかなかったキー。「取得したのに全部未対応」の原因切り分け用。
//   unmatchedScanAgs が多い = 対象パターンが実際の AssetGroup 名と合っていない可能性が高い。
export interface InspectionSources {
  scanRuns: number; mapRuns: number; scanScheds: number; mapScheds: number;
  scanRunsInQuarter: number; mapRunsInQuarter: number;
  unmatchedScanAgs: string[]; unmatchedMapDomains: string[];
  // 母集団の内訳: スナップショットの AssetGroup 総数と、パターンで対象外になったもの。
  agTotal: number; agMatched: number; agSkipped: string[];
}

export interface InspectionData {
  quarter: Quarter;
  scan: InspRow[];
  map: InspRow[];
  weeks: WeekSummary[];
  pending: PendingAg[];
  fetchedAt: string;
  pattern: string; // 適用した対象パターン（UI で提示して調整できるように）
  sources: InspectionSources;
}

// 四半期内のヒットのうち、対象キー集合に含まれないものを列挙（先頭 limit 件）。
function unmatched(hits: RunHit[], targets: InspTarget[], q: Quarter, limit = 50): { inQuarter: number; keys: string[] } {
  const known = new Set(targets.map((t) => norm(t.key)));
  const seen = new Set<string>();
  let inQuarter = 0;
  for (const h of hits) {
    const d = toDate(h.datetime);
    if (!d || d < q.start || d > q.end) continue;
    inQuarter++;
    const k = norm(h.key);
    if (k && !known.has(k)) seen.add(h.key.trim());
  }
  return { inQuarter, keys: [...seen].sort().slice(0, limit) };
}

export function computeInspection(
  records: QamRecords, raw: QamInspectionRaw | null, fiscalStartMonth: number, patternSrc: string, now: Date,
): InspectionData {
  const q = quarterOf(now, fiscalStartMonth);
  const t = buildTargets(records, agPattern(patternSrc));
  const scanHits = raw ? scanRunHits(parseScanList(raw.scans)) : [];
  const mapHits = raw ? mapRunHits(parseMapList(raw.maps)) : [];
  const scanScheds = raw ? scanSchedHits(parseScanSchedules(raw.scanSchedules)) : [];
  const mapScheds = raw ? mapSchedHits(parseMapSchedules(raw.mapSchedules)) : [];
  const scan = classify(t.scan, scanHits, scanScheds, q);
  const map = classify(t.map, mapHits, mapScheds, q);
  const us = unmatched(scanHits, t.scan, q);
  const um = unmatched(mapHits, t.map, q);
  return {
    quarter: q, scan, map,
    weeks: weeklySummary(scan, map, q),
    pending: pendingAgs(scan, map),
    fetchedAt: raw?.fetchedAt ?? '',
    pattern: patternSrc || DEFAULT_AG_PATTERN,
    sources: {
      scanRuns: scanHits.length, mapRuns: mapHits.length,
      scanScheds: scanScheds.length, mapScheds: mapScheds.length,
      scanRunsInQuarter: us.inQuarter, mapRunsInQuarter: um.inQuarter,
      unmatchedScanAgs: us.keys, unmatchedMapDomains: um.keys,
      agTotal: t.total, agMatched: t.scan.length, agSkipped: t.skipped.slice(0, 100),
    },
  };
}
