// 四半期 SCAN/MAP 検査コンプライアンス判定（純粋ロジック・UI/IO を持たない）。
//
// ルール:
//   - SCAN は AssetGroup 指定で実施。対象母集団は AG タイトルから切り出した
//     **接続点ID**（settenId = タイトル先頭〜最初の半角スペース）がパターンに一致するもの。
//     一覧も接続点ID 単位で出す（AssetGroup タイトルは参考表示）。
//   - MAP はドメイン指定で実施。対象は上記 AG に登録された DOMAIN_LIST のドメイン。
//     ドメイン未登録の AG は MAP 対象外。
//   - 「検査済み」= 現四半期内に完了した実施がある。
//   - 「スケジュール済み」= 現四半期内に次回実行予定があるアクティブなスケジュールがある。
//   - どちらも無ければ「未対応」。
import { settenId } from './config';
import type { QamInspectionRaw, QamRecords } from './types';
import type { MapRun, MapScheduleRow, ScanRun, ScanScheduleRow } from './inspection-parse';
import { parseMapList, parseMapSchedules, parseScanList, parseScanSchedules } from './inspection-parse';

export type InspKind = 'scan' | 'map';
export type InspStatus = 'done' | 'scheduled' | 'pending';

export interface QuarterWeek { no: number; start: Date; end: Date; label: string }
export interface Quarter { fy: number; q: number; label: string; start: Date; end: Date; weeks: QuarterWeek[] }

// 検査対象 1 件。
//   scan: key=接続点ID / ags=[接続点ID] / titles=元の AssetGroup タイトル
//   map : key=ドメイン / ags=そのドメインを登録している接続点ID / titles=その AssetGroup タイトル
export interface InspTarget { kind: InspKind; key: string; ags: string[]; titles: string[] }
// weekNo=実施週 / schedWeekNo=予約(次回実行)週。週次サマリで「実施」と「予約」を分けて数える。
export interface InspRow extends InspTarget {
  status: InspStatus; doneAt: string; weekNo: number | null; schedWeekNo: number | null; nextLaunch: string;
}

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

// 接続点ID が D で終わるものは動的（IP を登録せず運用する）ため、IP_SET 未登録でも SCAN 対象。
// D で終わらないのに IP_SET が未登録の AssetGroup は、スキャンする実体が無いので SCAN 対象外。
export const isScanEligible = (id: string, ips: string[]): boolean => /d$/i.test(id) || ips.length > 0;

// AssetGroup スナップショットから SCAN 対象（接続点ID）と MAP 対象ドメインを導出。
// パターンは AG タイトルそのものではなく、切り出した接続点ID に対して適用する。
// DOMAIN_LIST が空の AG は MAP 対象に出さない（＝MAP 対象外）。MAP の判定は SCAN 対象可否と独立。
// skipped=パターン不一致 / scanExcluded=上の IP 未登録ルールで SCAN 対象外。どちらも UI で理由を示す。
export interface BuiltTargets {
  scan: InspTarget[]; map: InspTarget[]; total: number; skipped: string[]; scanExcluded: string[];
}
export function buildTargets(records: QamRecords, pattern: RegExp): BuiltTargets {
  const skipped: string[] = [];
  const byId = new Map<string, InspTarget>();          // 接続点ID → SCAN 候補（同一IDの複数AGは束ねる）
  const domains = new Map<string, InspTarget>();       // ドメイン → MAP 対象
  const eligible = new Set<string>();                  // SCAN 対象になった接続点ID
  const excludedBy = new Map<string, string[]>();      // 接続点ID → 対象外だった AG タイトル
  let total = 0;
  const push = (t: InspTarget, ag: string, title: string): void => {
    if (!t.ags.includes(ag)) t.ags.push(ag);
    if (!t.titles.includes(title)) t.titles.push(title);
  };
  for (const r of Object.values(records)) {
    const title = (r.scalar.TITLE || r.name || '').trim();
    if (!title) continue;
    total++;
    const id = settenId(title);
    if (!id || !pattern.test(id)) { skipped.push(`${title}（ID: ${id || '—'}）`); continue; }
    const cur = byId.get(id) ?? { kind: 'scan' as const, key: id, ags: [id], titles: [] };
    push(cur, id, title);
    byId.set(id, cur);
    // 同一接続点に複数 AG がある場合、1 つでも対象条件を満たせばその接続点は SCAN 対象。
    if (isScanEligible(id, r.set.IPS ?? [])) eligible.add(id);
    else excludedBy.set(id, [...(excludedBy.get(id) ?? []), title]);
    for (const raw of r.set.DOMAIN_LIST ?? []) {
      const dom = norm(raw);
      if (!dom) continue;
      const d = domains.get(dom) ?? { kind: 'map' as const, key: dom, ags: [], titles: [] };
      push(d, id, title);
      domains.set(dom, d);
    }
  }
  const sortTarget = (t: InspTarget): InspTarget => ({ ...t, ags: [...t.ags].sort(), titles: [...t.titles].sort() });
  const byKey = (a: InspTarget, b: InspTarget): number => a.key.localeCompare(b.key);
  const scanExcluded = [...excludedBy.entries()]
    .filter(([id]) => !eligible.has(id))  // 別の AG で対象になった接続点は除外リストに出さない
    .flatMap(([id, titles]) => titles.map((t) => `${t}（ID: ${id}）`));
  return {
    scan: [...byId.values()].filter((t) => eligible.has(t.key)).map(sortTarget).sort(byKey),
    map: [...domains.values()].map(sortTarget).sort(byKey),
    total,
    skipped: skipped.sort(),
    scanExcluded: scanExcluded.sort(),
  };
}

// 実施・スケジュールを「対象キー → ヒット」の形へ正規化する。
// Qualys が返すのは AssetGroup タイトルなので、対象と突き合わせる前に接続点ID へ揃える。
export function scanRunHits(runs: ScanRun[]): RunHit[] {
  const out: RunHit[] = [];
  for (const r of runs) {
    if (!isFinished(r.state)) continue;
    for (const ag of r.assetGroups) out.push({ key: settenId(ag.trim()), datetime: r.datetime });
  }
  return out;
}
export const mapRunHits = (runs: MapRun[]): RunHit[] =>
  runs.filter((m) => isFinished(m.state) && m.domain).map((m) => ({ key: m.domain, datetime: m.datetime }));

export function scanSchedHits(rows: ScanScheduleRow[]): SchedHit[] {
  const out: SchedHit[] = [];
  for (const s of rows) for (const ag of s.assetGroups) out.push({ key: settenId(ag.trim()), nextLaunch: s.nextLaunch, active: s.active });
  return out;
}
// 1 タスクが複数ドメインを対象にできるので、ドメインごとのヒットに展開する。
export const mapSchedHits = (rows: MapScheduleRow[]): SchedHit[] =>
  rows.flatMap((m) => m.domains.map((d) => ({ key: d, nextLaunch: m.nextLaunch, active: m.active })));

// マップのスケジュールは AssetGroup 指定でも組める。接続点ID をキーにしたヒットも作る。
export const mapSchedAgHits = (rows: MapScheduleRow[]): SchedHit[] =>
  rows.flatMap((m) => m.assetGroups.map((ag) => ({ key: settenId(ag.trim()), nextLaunch: m.nextLaunch, active: m.active })));

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
    if (hit) return { ...t, status: 'done' as const, doneAt: hit.toISOString(), weekNo: weekNoOf(hit, q), schedWeekNo: null, nextLaunch: '' };
    const next = sched.get(k);
    if (next) return { ...t, status: 'scheduled' as const, doneAt: '', weekNo: null, schedWeekNo: weekNoOf(next, q), nextLaunch: next.toISOString() };
    return { ...t, status: 'pending' as const, doneAt: '', weekNo: null, schedWeekNo: null, nextLaunch: '' };
  });
}

// ドメインで一致しなかった MAP 対象を、その接続点にマップ予定があるかで補完する。
// （スケジュールが AssetGroup 指定のみで、TARGETS に当該ドメインが出てこない場合の救済）
export function fillMapScheduleByAg(rows: InspRow[], agScheds: SchedHit[], q: Quarter): InspRow[] {
  const byAg = new Map<string, Date>();
  for (const s of agScheds) {
    if (!s.active) continue;
    const d = toDate(s.nextLaunch);
    const k = norm(s.key);
    if (!d || !k || d < q.start || d > q.end) continue;
    const prev = byAg.get(k);
    if (!prev || d < prev) byAg.set(k, d);
  }
  if (!byAg.size) return rows;
  return rows.map((r) => {
    if (r.status !== 'pending') return r;
    let best: Date | null = null;
    for (const ag of r.ags) {
      const d = byAg.get(norm(ag));
      if (d && (!best || d < best)) best = d;
    }
    return best ? { ...r, status: 'scheduled' as const, schedWeekNo: weekNoOf(best, q), nextLaunch: best.toISOString() } : r;
  });
}

export interface StatusCounts { done: number; scheduled: number; pending: number; total: number }
export function countStatus(rows: InspRow[]): StatusCounts {
  const c: StatusCounts = { done: 0, scheduled: 0, pending: 0, total: rows.length };
  for (const r of rows) c[r.status]++;
  return c;
}

// 週次サマリ: その週の実施件数・予約件数と、四半期開始からの累計（実施＋予約）。
export interface WeekSummary {
  no: number; label: string; period: string;
  scanDone: number; scanSched: number; scanCum: number;
  mapDone: number; mapSched: number; mapCum: number;
}
export function weeklySummary(scan: InspRow[], map: InspRow[], q: Quarter): WeekSummary[] {
  let scanCum = 0;
  let mapCum = 0;
  const count = (rows: InspRow[], field: 'weekNo' | 'schedWeekNo', no: number): number =>
    rows.filter((r) => r[field] === no).length;
  return q.weeks.map((w) => {
    const sd = count(scan, 'weekNo', w.no);
    const ss = count(scan, 'schedWeekNo', w.no);
    const md = count(map, 'weekNo', w.no);
    const ms = count(map, 'schedWeekNo', w.no);
    scanCum += sd + ss; // 累計は「実施＋予約」
    mapCum += md + ms;
    return {
      no: w.no, label: w.label, period: w.label.replace(/^第\d+週 \((.*)\)$/, '$1'),
      scanDone: sd, scanSched: ss, scanCum, mapDone: md, mapSched: ms, mapCum,
    };
  });
}

// 検査一覧の 1 行。実行履歴（実施済み）と予約済み（スケジュール）を同じ表に並べる。
//   category: 'run'=実行履歴 / 'schedule'=予約済み
//   datetime: run=実施日時 / schedule=次回実行予定
export interface InspEntry {
  kind: InspKind;
  category: 'run' | 'schedule';
  title: string;
  target: string;   // AssetGroup タイトルまたはドメイン
  setten: string;   // 対象から導いた接続点ID（scan のみ。map は空）
  datetime: string;
  state: string;    // run=Finished 等 / schedule=有効・無効
  ref: string;
}

export function buildEntries(
  scanRuns: ScanRun[], mapRuns: MapRun[], scanScheds: ScanScheduleRow[], mapScheds: MapScheduleRow[],
): InspEntry[] {
  const out: InspEntry[] = [];
  const ags = (list: string[]): string => list.join(', ');
  for (const r of scanRuns) {
    out.push({
      kind: 'scan', category: 'run', title: r.title, target: ags(r.assetGroups),
      setten: r.assetGroups.map((a) => settenId(a.trim())).filter(Boolean).join(', '),
      datetime: r.datetime, state: r.state || '—', ref: r.ref,
    });
  }
  for (const m of mapRuns) {
    out.push({ kind: 'map', category: 'run', title: m.title, target: m.domain, setten: '', datetime: m.datetime, state: m.state || '—', ref: m.ref });
  }
  for (const s of scanScheds) {
    out.push({
      kind: 'scan', category: 'schedule', title: s.title, target: ags(s.assetGroups),
      setten: s.assetGroups.map((a) => settenId(a.trim())).filter(Boolean).join(', '),
      datetime: s.nextLaunch, state: s.active ? '有効' : '無効', ref: s.id,
    });
  }
  for (const m of mapScheds) {
    out.push({
      kind: 'map', category: 'schedule', title: m.title, target: m.domains.join(', '),
      setten: m.assetGroups.map((a) => settenId(a.trim())).filter(Boolean).join(', '),
      datetime: m.nextLaunch, state: m.active ? '有効' : '無効', ref: m.id,
    });
  }
  // 新しい順（日時が読めないものは末尾）。
  return out.sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}

// 対象×週マトリクスの 1 行（接続点単位で SCAN と MAP を併記する統合行）。
// MAP は接続点配下の全ドメインを集約: 1つでも未対応なら未対応 / 残りが予約のみなら予約 / 全部済なら検査済み。
export interface MatrixRow {
  ag: string;                 // 接続点ID
  titles: string[];           // AssetGroup タイトル
  domains: string[];          // MAP 対象ドメイン（空 = MAP 対象外）
  scanStatus: InspStatus | null;   // null = SCAN 対象に無い（通常は起こらない）
  mapStatus: InspStatus | null;    // null = MAP 対象外
  scanDoneWeek: number | null;
  scanSchedWeek: number | null;
  mapDoneWeeks: number[];
  mapSchedWeeks: number[];
}

function aggregateMapStatus(rows: InspRow[]): InspStatus | null {
  if (!rows.length) return null;
  if (rows.some((r) => r.status === 'pending')) return 'pending';
  if (rows.some((r) => r.status === 'scheduled')) return 'scheduled';
  return 'done';
}

export function buildMatrix(scan: InspRow[], map: InspRow[]): MatrixRow[] {
  const mapByAg = new Map<string, InspRow[]>();
  for (const m of map) for (const ag of m.ags) mapByAg.set(ag, [...(mapByAg.get(ag) ?? []), m]);
  const ags = new Set<string>([...scan.map((s) => s.key), ...mapByAg.keys()]);
  const weeks = (rows: InspRow[], field: 'weekNo' | 'schedWeekNo'): number[] =>
    [...new Set(rows.map((r) => r[field]).filter((n): n is number => n != null))].sort((a, b) => a - b);
  return [...ags].sort((a, b) => a.localeCompare(b)).map((ag) => {
    const s = scan.find((r) => r.key === ag) ?? null;
    const ms = mapByAg.get(ag) ?? [];
    return {
      ag,
      titles: s ? s.titles : [...new Set(ms.flatMap((m) => m.titles))].sort(),
      domains: ms.map((m) => m.key).sort(),
      scanStatus: s ? s.status : null,
      mapStatus: aggregateMapStatus(ms),
      scanDoneWeek: s?.weekNo ?? null,
      scanSchedWeek: s?.schedWeekNo ?? null,
      mapDoneWeeks: weeks(ms, 'weekNo'),
      mapSchedWeeks: weeks(ms, 'schedWeekNo'),
    };
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
  // Rows = 応答XMLから読めた件数 / それ以外 = 対象キーに展開したヒット数。
  // 「Rows はあるのにヒットが 0」なら、対象キー（AssetGroup 名やドメイン）が応答に入っていない。
  scanRunRows: number; mapRunRows: number; scanSchedRows: number; mapSchedRows: number;
  scanRuns: number; mapRuns: number; scanScheds: number; mapScheds: number;
  scanRunsInQuarter: number; mapRunsInQuarter: number;
  unmatchedScanAgs: string[]; unmatchedMapDomains: string[];
  // 母集団の内訳: スナップショットの AssetGroup 総数と、対象外になったもの。
  //   agSkipped   = 接続点ID がパターンに一致しない
  //   agScanExcluded = パターンには一致するが IP 未登録ルールで SCAN 対象外
  agTotal: number; agMatched: number; agSkipped: string[]; agScanExcluded: string[];
}

export interface InspectionData {
  quarter: Quarter;
  scan: InspRow[];
  map: InspRow[];
  weeks: WeekSummary[];
  matrix: MatrixRow[];
  entries: InspEntry[];   // 実行履歴＋予約済みの一覧
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
  // 応答から読めた行（Rows）と、対象キーへ展開したヒットを別々に持つ（切り分け用）。
  const scanRunRows = raw ? parseScanList(raw.scans) : [];
  const mapRunRows = raw ? parseMapList(raw.maps) : [];
  const scanSchedRows = raw ? parseScanSchedules(raw.scanSchedules) : [];
  const mapSchedRows = raw ? parseMapSchedules(raw.mapSchedules) : [];
  const scanHits = scanRunHits(scanRunRows);
  const mapHits = mapRunHits(mapRunRows);
  const scanScheds = scanSchedHits(scanSchedRows);
  const mapScheds = mapSchedHits(mapSchedRows);
  const scan = classify(t.scan, scanHits, scanScheds, q);
  // ドメイン照合 → 接続点ID による補完、の順で MAP を確定する。
  const map = fillMapScheduleByAg(classify(t.map, mapHits, mapScheds, q), mapSchedAgHits(mapSchedRows), q);
  const us = unmatched(scanHits, t.scan, q);
  const um = unmatched(mapHits, t.map, q);
  return {
    quarter: q, scan, map,
    weeks: weeklySummary(scan, map, q),
    matrix: buildMatrix(scan, map),
    entries: buildEntries(scanRunRows, mapRunRows, scanSchedRows, mapSchedRows),
    pending: pendingAgs(scan, map),
    fetchedAt: raw?.fetchedAt ?? '',
    pattern: patternSrc || DEFAULT_AG_PATTERN,
    sources: {
      scanRunRows: scanRunRows.length, mapRunRows: mapRunRows.length,
      scanSchedRows: scanSchedRows.length, mapSchedRows: mapSchedRows.length,
      scanRuns: scanHits.length, mapRuns: mapHits.length,
      scanScheds: scanScheds.length, mapScheds: mapScheds.length,
      scanRunsInQuarter: us.inQuarter, mapRunsInQuarter: um.inQuarter,
      unmatchedScanAgs: us.keys, unmatchedMapDomains: um.keys,
      agTotal: t.total, agMatched: t.scan.length,
      agSkipped: t.skipped.slice(0, 100), agScanExcluded: t.scanExcluded.slice(0, 100),
    },
  };
}
