// Qualys API ダウンロード: relay 経由でプロキシ取得し、Host の nextUrl ページングを辿って
// 全件をマージ → 正規化スナップショットにする。XML アップロードと同じ正規化(parse)に合流。
import { parseQualysXml } from './ingest/parse';
import { fetchQualys, fetchQualysBatch, fetchBatchResult, PAGE_SEP, qualysUserAdd, qualysScheduleAdd, qualysReportFetch, type FetchResult } from './relay';
import { SCHEDULE_PATHS, scheduleParams, validateSchedule, type ScheduleInput } from './schedule';
import { parseTicketPages, type TicketQuery } from './tickets';
import type { QamEntity, QamInspectionRaw, QamRecords, QamSnapshot, QamTicket } from './types';

// pass は平文、secret は DPAPI 暗号文。secret があれば relay 側でだけ復号され、
// ブラウザは平文を持たない。どちらか一方が入っていればよい。
export interface QualysCreds { base: string; user: string; pass: string; proxy: string; secret?: string }

export interface DownloadResult { snapshot: QamSnapshot; raw: string; pages: number }
export type DownloadProgress = (p: { page: number; records: number }) => void;

// 失敗応答から人間向けの理由を抜く（Qualys は HTML や <SIMPLE_RETURN><TEXT> で返すことがある）。
function failReason(res: { error?: string; xml?: string }): string {
  const body = (res.xml || '').replace(/<\?xml[^>]*\?>/i, '');
  const m = body.match(/<TEXT>([\s\S]*?)<\/TEXT>/i) || body.match(/<title>([\s\S]*?)<\/title>/i);
  const txt = (m ? m[1] : body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return res.error || txt.slice(0, 200);
}

// IPv4 → 整数（IP_RANGE 展開用）。不正は null。
function ipToInt(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

// IPs in Subscription を XML から数える（/api/2.0/fo/asset/ip/?action=list の応答）。
// <IP> は1点、<IP_RANGE>a-b</IP_RANGE> は [a,b] 区間。これらの和集合の要素数＝一意IP数を返す。
// 単純合計だと「単一IPがレンジに含まれる」「レンジ同士が重なる」場合に二重計上し、Qualys UI の
// 値より多くなる（重複1つで +1）。区間をマージして重複を除外し、Qualys のカウントに一致させる。
export function countSubscriptionIps(xml: string): number {
  const intervals: [number, number][] = [];
  for (const m of xml.matchAll(/<IP(?:\s[^>]*)?>([^<]+)<\/IP>/gi)) {
    const v = ipToInt(m[1]); if (v !== null) intervals.push([v, v]);
  }
  for (const m of xml.matchAll(/<IP_RANGE(?:\s[^>]*)?>([^<]+)<\/IP_RANGE>/gi)) {
    const [a, b] = m[1].split('-').map((x) => x.trim());
    const ai = ipToInt(a); const bi = ipToInt(b);
    if (ai !== null && bi !== null && bi >= ai) intervals.push([ai, bi]);
  }
  intervals.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let total = 0; let curStart = -1; let curEnd = -2;
  for (const [s, e] of intervals) {
    if (s > curEnd) { total += curEnd - curStart + 1; curStart = s; curEnd = e; } // 非重複：直前区間を確定し新区間へ
    else if (e > curEnd) curEnd = e; // 重複：区間を拡張（重なり分は数えない）
  }
  if (curStart >= 0) total += curEnd - curStart + 1; // 末尾区間
  return total;
}

// asset/ip 応答から単体IP/レンジのトークン一覧を抽出（診断・差分用）。
export function extractIpTokens(xml: string): { singles: string[]; ranges: string[] } {
  const singles: string[] = [];
  for (const m of xml.matchAll(/<IP(?:\s[^>]*)?>([^<]+)<\/IP>/gi)) { if (ipToInt(m[1]) !== null) singles.push(m[1].trim()); }
  const ranges: string[] = [];
  for (const m of xml.matchAll(/<IP_RANGE(?:\s[^>]*)?>([^<]+)<\/IP_RANGE>/gi)) ranges.push(m[1].trim());
  return { singles, ranges };
}

// IPスコープ診断: asset/ip を「フィルタ無し / VM限定 / CertView / PC」で取得し、件数とIP一覧を返す。
// 「全体にあって VM限定に無いIP」を見れば、UI(VM)との差分IPがどのスコープ由来かを特定できる。
export interface IpScopeRow { label: string; key: string; ok: boolean; unique: number | null; singles: string[]; ranges: string[]; error?: string }
export async function diagnoseSubscriptionIps(creds: QualysCreds): Promise<IpScopeRow[]> {
  const base = creds.base.replace(/\/+$/, '');
  const variants: { label: string; key: string; q: string }[] = [
    { label: '全モジュール（フィルタ無し＝ツール既定）', key: 'all', q: '' },
    { label: 'VM限定（compliance_enabled=0&certview_enabled=0）', key: 'vm', q: '&compliance_enabled=0&certview_enabled=0' },
    { label: 'CertView（certview_enabled=1）', key: 'certview', q: '&certview_enabled=1' },
    { label: 'PC（compliance_enabled=1）', key: 'pc', q: '&compliance_enabled=1' },
  ];
  const rows: IpScopeRow[] = [];
  for (const v of variants) {
    const r = await fetchQualys({ base, user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, noSession: true, url: `${base}/api/2.0/fo/asset/ip/?action=list${v.q}` });
    if (r.ok) { const t = extractIpTokens(r.xml); rows.push({ label: v.label, key: v.key, ok: true, unique: countSubscriptionIps(r.xml), singles: t.singles, ranges: t.ranges }); }
    else rows.push({ label: v.label, key: v.key, ok: false, unique: null, singles: [], ranges: [], error: r.error || `HTTP ${r.status}` });
  }
  return rows;
}

// IPs in Subscription の重複チェック。<IP>（単体）と <IP_RANGE>（レンジ）を区間化し、
// 重なり（単体×レンジ・レンジ×レンジ・完全重複）を検出して、件数のズレ要因を可視化する。
const ipIntToStr = (n: number): string => `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
export interface IpDupPair { a: string; b: string; overlap: number } // a と b が overlap 個のIPで重複
export interface IpDupReport { unique: number; rawSum: number; duplicates: number; pairs: IpDupPair[]; truncated: boolean }
export function analyzeSubscriptionIps(xml: string, maxPairs = 500): IpDupReport {
  const items: { raw: string; a: number; b: number }[] = [];
  for (const m of xml.matchAll(/<IP(?:\s[^>]*)?>([^<]+)<\/IP>/gi)) {
    const v = ipToInt(m[1]); if (v !== null) items.push({ raw: m[1].trim(), a: v, b: v });
  }
  for (const m of xml.matchAll(/<IP_RANGE(?:\s[^>]*)?>([^<]+)<\/IP_RANGE>/gi)) {
    const [s, e] = m[1].split('-').map((x) => x.trim());
    const ai = ipToInt(s); const bi = ipToInt(e);
    if (ai !== null && bi !== null && bi >= ai) items.push({ raw: `${ipIntToStr(ai)}-${ipIntToStr(bi)}`, a: ai, b: bi });
  }
  const rawSum = items.reduce((n, it) => n + (it.b - it.a + 1), 0);
  // 一意IP数（区間ユニオン）
  const sorted = [...items].sort((x, y) => x.a - y.a || x.b - y.b);
  let unique = 0; let cs = -1; let ce = -2;
  for (const it of sorted) { if (it.a > ce) { unique += ce - cs + 1; cs = it.a; ce = it.b; } else if (it.b > ce) ce = it.b; }
  if (cs >= 0) unique += ce - cs + 1;
  // 重複ペア検出（開始順スイープ。終了済みは捨てる）。
  const pairs: IpDupPair[] = []; let truncated = false;
  const active: { raw: string; a: number; b: number }[] = [];
  for (const it of sorted) {
    for (let i = active.length - 1; i >= 0; i--) { if (active[i].b < it.a) active.splice(i, 1); } // 重ならない過去を除去
    for (const p of active) {
      const ov = Math.min(p.b, it.b) - Math.max(p.a, it.a) + 1;
      if (ov > 0) { if (pairs.length < maxPairs) pairs.push({ a: p.raw, b: it.raw, overlap: ov }); else truncated = true; }
    }
    active.push(it);
  }
  return { unique, rawSum, duplicates: rawSum - unique, pairs, truncated };
}

export interface IpListResult { count: number | null; xml: string }

// 複数種別をまとめて取得する（relay 内部で種別ごとに並列実行）。
// relay の listener は逐次ループなので、ブラウザから並列に投げても直列化される。
// そのため「1 リクエストで種別のリストを渡し、relay 側で並列に走らせる」形にしている。
// ページ送りはカーソル方式（次ページURLが応答に入る）なので、種別内は逐次のまま。
export interface BatchDownload { kind: QamEntity; snapshot: QamSnapshot; raw: string; pages: number }
// 並列取得の結果に IPs in Subscription も含める（種別と一緒に取る＝待ち時間が重ならない）。
export interface TicketResult { tickets: QamTicket[]; raw: string; query: TicketQuery }
export interface BatchResult { results: BatchDownload[]; failures: { kind: string; error: string }[]; ips?: IpListResult; tickets?: TicketResult; inspection?: InspectionDownload }
export async function downloadEntitiesParallel(
  kinds: QamEntity[], creds: QualysCreds, onProgress?: (msg: string) => void, withIps = false, ticketOpt?: TicketQuery, inspectionAfter?: string,
): Promise<BatchResult> {
  // IPs in Subscription も同じプールで取る。別に await すると、その待ち時間だけ
  // 並列化の効果が削られる（種別4つを並列にしても IPs の分は直列に足される）。
  const all: string[] = withIps ? [...kinds, 'ips'] : [...kinds];
  // チケットも同じ波で取る（別に await すると、その待ち時間がそのまま総時間に足される）。
  if (ticketOpt) all.push('ticket');
  // 検査(実施済み scan/map ＋ それぞれのスケジュール)も同じ波で取る。
  const INSP_KINDS = [['scan', '実施済みスキャン'], ['map', '実施済みマップ'], ['scansched', 'スキャンのスケジュール'], ['mapsched', 'マップのスケジュール']] as const;
  if (inspectionAfter !== undefined) all.push(...INSP_KINDS.map(([k]) => k));
  onProgress?.(`${all.length} 件を並列で取得中…`);
  const res = await fetchQualysBatch({ kinds: all, base: creds.base, user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, since: ticketOpt?.since ?? '', states: ticketOpt?.states ?? '', after: inspectionAfter ?? '' });
  if (!res.ok) throw new Error(res.error || '並列取得に失敗しました');
  const results: BatchDownload[] = [];
  const failures: { kind: string; error: string }[] = [];
  let ips: IpListResult | undefined;
  let tickets: TicketResult | undefined;
  const insp: Record<string, string> = {};
  const inspWarn: string[] = [];
  for (const item of res.items ?? []) {
    if (item.kind === 'ips') {
      // 失敗しても取込自体は続ける（ライセンス数が出ないだけ）。
      if (!item.ok) { ips = { count: null, xml: '' }; continue; }
      const xml = await fetchBatchResult('ips');
      ips = { count: countSubscriptionIps(xml), xml };
      continue;
    }
    if (item.kind === 'ticket') {
      // チケットが取れなくても資産の取込は続ける（失敗は呼び出し側が failures で名指しする）。
      if (!item.ok) { failures.push({ kind: 'ticket', error: item.error || '取得に失敗しました' }); continue; }
      const raw = await fetchBatchResult('ticket');
      tickets = { tickets: parseTicketPages(raw.split(PAGE_SEP)), raw, query: ticketOpt! };
      continue;
    }
    const inspLabel = INSP_KINDS.find(([k]) => k === item.kind)?.[1];
    if (inspLabel) {
      // 検査は 1 本でも取れれば表示する（契約/版でエンドポイントの有無に差があるため）。
      // 取れなかったものは warnings に残し、黙って 0 件にしない。
      if (!item.ok) { inspWarn.push(`${inspLabel}: ${item.error || '取得に失敗しました'}`); continue; }
      const xml = await fetchBatchResult(item.kind);
      const err = qualysErrorText(xml); // HTTP 200 でも本文がエラーなら失敗扱い
      if (err) { inspWarn.push(`${inspLabel}: ${err}`); continue; }
      insp[item.kind] = xml;
      continue;
    }
    const kind = item.kind as QamEntity;
    if (!item.ok) { failures.push({ kind, error: item.error || '取得に失敗しました' }); continue; }
    onProgress?.(`${kind}: 受け取り中…（${item.pages} ページ）`);
    const raw = await fetchBatchResult(kind);
    // relay は複数ページを PAGE_SEP で連結して返す。ページごとに解析して records を統合する
    // （XML 文書としては 1 ページ 1 文書なので、まとめてパースはできない）。
    const records: QamRecords = {};
    let datetime = '';
    for (const page of raw.split(PAGE_SEP)) {
      if (!page.trim()) continue;
      const parsed = parseQualysXml(page, kind);
      Object.assign(records, parsed.records);
      if (!datetime) datetime = parsed.datetime;
    }
    results.push({ kind, snapshot: { entity: kind, datetime, records }, raw, pages: item.pages });
  }
  const inspection: InspectionDownload | undefined = inspectionAfter === undefined ? undefined : {
    raw: { scans: insp.scan ?? '', maps: insp.map ?? '', scanSchedules: insp.scansched ?? '', mapSchedules: insp.mapsched ?? '', fetchedAt: new Date().toISOString() },
    warnings: inspWarn,
  };
  return { results, failures, ips, tickets, inspection };
}

// ──────────────────────────────────────────────────────────────────────────
// 四半期検査（SCAN/MAP の実施済み・スケジュール）の取得。
// relay は単スレッドなので順次取得する（並列にすると取りこぼす）。
// ──────────────────────────────────────────────────────────────────────────
export type InspectionProgress = (label: string) => void;

// Qualys の日時パラメータ形式 'YYYY-MM-DDTHH:MM:SSZ'（ミリ秒は付けない）。
const qualysDateTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export { qualysDateTime as qualysDateTimeUtc };

// 1本でも取れれば表示する（エンドポイントの有無は契約/版で差があるため、全滅時だけ例外）。
export interface InspectionDownload { raw: QamInspectionRaw; warnings: string[] }

// Qualys は不正パラメータ等を HTTP 200 + <SIMPLE_RETURN><TEXT> や <ERROR> で返すことがある。
// ok だけ見ると「エラー」と「0 件」を区別できず、黙って未対応表示になるので本文も検査する。
// 一覧取得（GET）用。一覧を頼んだのに SIMPLE_RETURN が返るのは、それ自体が異常。
export function qualysErrorText(xml: string): string {
  if (/<(SIMPLE|GENERIC)_RETURN/i.test(xml)) {
    const m = xml.match(/<TEXT>([\s\S]*?)<\/TEXT>/i);
    return (m ? m[1] : 'Qualys がエラーを返しました').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const e = xml.match(/<ERROR[^>]*>([\s\S]*?)<\/ERROR>/i);
  return e ? e[1].replace(/\s+/g, ' ').trim() : '';
}

/**
 * 実行系（POST: update / launch など）用。
 * ★SIMPLE_RETURN は**成功でも返る**（成功: <TEXT>search list updated successfully</TEXT>）。
 *   一覧用と同じ判定を使うと、更新が通っているのに「失敗 — updated successfully」と出る（実際に踏んだ）。
 *   失敗かどうかは <CODE> の有無で見る。
 */
export function qualysActionError(xml: string): string {
  if (/<(SIMPLE|GENERIC)_RETURN/i.test(xml)) {
    if (!/<CODE>/i.test(xml)) return '';
    const code = xml.match(/<CODE>([\s\S]*?)<\/CODE>/i)?.[1]?.trim() ?? '';
    const m = xml.match(/<TEXT>([\s\S]*?)<\/TEXT>/i);
    const text = (m ? m[1] : 'Qualys がエラーを返しました').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return code ? `${text}（コード ${code}）` : text;
  }
  const e = xml.match(/<ERROR[^>]*>([\s\S]*?)<\/ERROR>/i);
  return e ? e[1].replace(/\s+/g, ' ').trim() : '';
}

// 四半期検査の取得。実体は並列プール（downloadEntitiesParallel）に載せる。
// ★別経路で1本ずつ取ると、その待ち時間がそのまま総時間に足される。
export async function downloadInspection(
  creds: QualysCreds, quarterStart: Date, onProgress?: InspectionProgress,
): Promise<InspectionDownload> {
  onProgress?.('検査履歴・スケジュールを取得中');
  const res = await downloadEntitiesParallel([], creds, undefined, false, undefined, qualysDateTime(quarterStart));
  const insp = res.inspection!;
  const r = insp.raw;
  // 1 本も取れなかったときだけ失敗にする（エンドポイントの有無は契約/版で差がある）。
  if (!r.scans && !r.maps && !r.scanSchedules && !r.mapSchedules) {
    throw new Error(insp.warnings.join(' / ') || '取得に失敗しました');
  }
  return insp;
}

// ──────────────────────────────────────────────────────────────────────────
// スケジュール登録（作成のみ）。SCAN=v2・MAP=v1 でパラメータ形式が違うが、
// 送信は relay の form POST に統一する（組立と検証は schedule.ts）。
// ──────────────────────────────────────────────────────────────────────────

// 応答の成否判定。Qualys は HTTP 200 でも本文でエラーを返すので本文を見る。
//   v2: <SIMPLE_RETURN>…<CODE>…</CODE><TEXT>…</TEXT>  ← CODE があればエラー
//   v1: <GENERIC_RETURN><RETURN status="FAILED"><TEXT>…  ← status で判定
// どちらでもない未知の形は、TEXT が取れればそれを、無ければ成功として扱う。
export function scheduleResult(xml: string): { ok: boolean; message: string } {
  const text = (xml.match(/<TEXT>([\s\S]*?)<\/TEXT>/i)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const status = xml.match(/<RETURN[^>]*\bstatus="([^"]+)"/i)?.[1];
  if (status) return { ok: /success/i.test(status), message: text || status };
  if (/<CODE>/i.test(xml)) return { ok: false, message: text || 'Qualys がエラーを返しました' };
  return { ok: true, message: text || '登録しました' };
}

export async function createSchedule(creds: QualysCreds, input: ScheduleInput, author: string): Promise<{ message: string }> {
  const errors = validateSchedule(input);
  if (errors.length) throw new Error(errors.join(' / '));
  const res = await qualysScheduleAdd({
    base: creds.base.replace(/\/+$/, ''), user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy,
    path: SCHEDULE_PATHS[input.kind], author, fields: scheduleParams(input),
  });
  if (res.error) throw new Error(res.error);
  const r = scheduleResult(res.xml ?? '');
  if (!r.ok) throw new Error(r.message);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${r.message}`); // 本文が読めない失敗
  return { message: r.message };
}

// ──────────────────────────────────────────────────────────────────────────
// 検査登録の前段: AssetGroup 作成 / ドメイン登録 と、その重複確認。
// いずれも Qualys への書き込みなので relay の schedule-add 経路（form POST・監査ログ付き）を使う。
// ──────────────────────────────────────────────────────────────────────────
export const ASSET_GROUP_PATH = '/api/2.0/fo/asset/group/';
export const DOMAIN_ADD_PATH = '/msp/asset_domain.php';

async function writeQualys(
  creds: QualysCreds, path: string, fields: Record<string, string>, author: string,
): Promise<{ message: string }> {
  const res = await qualysScheduleAdd({
    base: creds.base.replace(/\/+$/, ''), user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy,
    path, author, fields,
  });
  if (res.error) throw new Error(res.error);
  const r = scheduleResult(res.xml ?? '');
  if (!r.ok) throw new Error(r.message);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${r.message}`);
  return { message: r.message };
}

// 同名の AssetGroup があるか（title は完全一致で検索できる）。あれば ID を返す。
export async function findAssetGroup(creds: QualysCreds, title: string): Promise<{ id: string } | null> {
  const base = creds.base.replace(/\/+$/, '');
  const url = `${base}${ASSET_GROUP_PATH}?action=list&title=${encodeURIComponent(title)}`;
  const res = await fetchQualys({ base, user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, noSession: true, url });
  if (!res.ok || !res.xml) throw new Error(`AssetGroup の確認に失敗 (status ${res.status}): ${failReason(res)}`);
  const err = qualysErrorText(res.xml);
  if (err) throw new Error(err);
  const id = res.xml.match(/<ID>([^<]+)<\/ID>/i)?.[1]?.trim();
  return id ? { id } : null;
}

// 登録済みドメインか（サブスクリプションのドメイン一覧から探す）。
// 既存のネットブロックも返す: 更新（action=edit）は netblock 必須で送った内容が正になるため、
// 既存分を消さないよう「既存 + 追加分」を送る必要がある。
export interface DomainInfo { name: string; netblocks: string[] }
export async function findDomain(creds: QualysCreds, domain: string): Promise<DomainInfo | null> {
  const base = creds.base.replace(/\/+$/, '');
  const url = `${base}/api/2.0/fo/asset/domain/?action=list`;
  const res = await fetchQualys({ base, user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, noSession: true, url });
  if (!res.ok || !res.xml) throw new Error(`ドメインの確認に失敗 (status ${res.status}): ${failReason(res)}`);
  const want = domain.trim().toLowerCase();
  try {
    // 一覧の正規化（NETBLOCK/RANGE の解釈込み）は取込と同じパーサに任せる。
    for (const r of Object.values(parseQualysXml(res.xml, 'domain').records)) {
      const name = (r.scalar.DOMAIN_NAME || r.name || '').trim();
      if (name.toLowerCase() === want) return { name, netblocks: r.set.NETBLOCK ?? [] };
    }
    return null;
  } catch {
    // 版差で解析できない場合は名前の有無だけ見る（ネットブロックは不明＝空扱い）。
    for (const m of res.xml.matchAll(/<DOMAIN(?:_NAME)?(?:\s[^>]*)?>([^<]+)<\/DOMAIN(?:_NAME)?>/gi)) {
      if (m[1].trim().toLowerCase() === want) return { name: m[1].trim(), netblocks: [] };
    }
    return null;
  }
}

export const createAssetGroup = (creds: QualysCreds, fields: Record<string, string>, author: string): Promise<{ message: string }> =>
  writeQualys(creds, ASSET_GROUP_PATH, fields, author);

// 既存 AssetGroup の更新。fields には action=edit / id / add_ips 等を渡す（組立は provision.ts）。
export const editAssetGroup = (creds: QualysCreds, fields: Record<string, string>, author: string): Promise<{ message: string }> =>
  writeQualys(creds, ASSET_GROUP_PATH, fields, author);

// ドメインの登録・更新。fields には action=add|edit / domain / netblock(任意) を渡す。
export const writeDomain = (creds: QualysCreds, fields: Record<string, string>, author: string): Promise<{ message: string }> =>
  writeQualys(creds, DOMAIN_ADD_PATH, fields, author);

// ──────────────────────────────────────────────────────────────────────────
// ユーザ登録（/msp/user.php?action=add）。言語/SAMLはAPI非対応のため扱わない。
// SAMLは「新規ユーザにSSO有効化」をQualysサブスクリプション側で設定する前提。
// ──────────────────────────────────────────────────────────────────────────
export type ScanType = 'static' | 'dynamic';
export type UserRole = 'scanner' | 'reader';
export interface UserAddInput {
  fullName: string;        // 氏名（全角スペース区切り「姓 名」。英字は全角入力でも可）
  email: string;
  scanType: ScanType;      // 検査対象区分（独自概念・役割ルールにのみ使用、Qualysへは送らない）
  role: UserRole;          // 静的時の選択。動的は reader 固定
  assetGroups: string[];   // 接続点IDから解決した AssetGroup タイトル
  businessUnit: string;    // 共通設定
  country: string;         // 共通設定（Qualysが受け付ける国名）
}

// 全角ASCII(！-～)→半角、全角スペース→半角スペース。漢字・かなはそのまま。
export function toHalfWidth(s: string): string {
  return (s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

// 氏名「姓 名」を分割（全角/半角スペース区切り）。英字の全角は半角化。姓=先頭トークン, 名=残り。
export function splitJpName(fullName: string): { lastName: string; firstName: string } {
  const norm = toHalfWidth(fullName).trim().replace(/\s+/g, ' ');
  const parts = norm ? norm.split(' ') : [];
  return { lastName: parts[0] ?? '', firstName: parts.slice(1).join(' ') };
}

// 検査対象区分による役割確定。動的は Reader 固定、静的は選択値。
export const roleForScanType = (scanType: ScanType, picked: UserRole): UserRole =>
  (scanType === 'dynamic' ? 'reader' : picked);

// user.php?action=add に渡すフィールド。必須の title/phone/address1/city は "-"。
// 値が空のもの（asset_groups 等）は呼び出し側/relay で除外する。
export function buildUserAddFields(input: UserAddInput): Record<string, string> {
  const { lastName, firstName } = splitJpName(input.fullName);
  const f: Record<string, string> = {
    user_role: roleForScanType(input.scanType, input.role),
    business_unit: input.businessUnit.trim(),
    first_name: firstName,
    last_name: lastName,
    email: input.email.trim(),
    title: '-', phone: '-', address1: '-', city: '-',
    country: input.country.trim(),
    send_email: '0', // SAML運用：登録メール（パスワード設定案内）は送らない
  };
  if (input.assetGroups.length) f.asset_groups = input.assetGroups.join(',');
  return f;
}

// Qualys へユーザを1人登録。成功時は作成された USER_LOGIN を返す。失敗は例外。
export async function addQualysUser(creds: QualysCreds, input: UserAddInput): Promise<{ login: string }> {
  const fields = buildUserAddFields(input);
  const res = await qualysUserAdd({ base: creds.base, user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, fields });
  if (!res.ok) throw new Error(res.error || 'ユーザ登録に失敗しました');
  return { login: res.login ?? '' };
}


// ──────────────────────────────────────────────────────────────────────────
// 動的検索リスト（日次更新）。取得は v3.0 の action=list、更新は action=update。
// ★update にするのは ID を保つため。delete+create にすると設定に登録した ID が無効になる。
// ──────────────────────────────────────────────────────────────────────────
export async function fetchSearchLists(creds: QualysCreds, ids: string[]): Promise<string> {
  const base = creds.base.replace(/\/+$/, '');
  const res = await fetchQualys({
    kind: 'searchlist', base, ids: ids.join(','),
    user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, noSession: true,
  });
  if (!res.ok || !res.xml) throw new Error(`検索リストを取得できません (status ${res.status}): ${failReason(res) || '権限を確認してください'}`);
  const err = qualysErrorText(res.xml);
  if (err) throw new Error(err); // 200 でも本文がエラーなら失敗扱い
  return res.xml;
}

const SEARCH_LIST_PATH = '/api/3.0/fo/qid/search_list/dynamic/';

export async function updateSearchList(creds: QualysCreds, author: string, fields: Record<string, string>): Promise<void> {
  const res = await qualysScheduleAdd({
    base: creds.base.replace(/\/+$/, ''), user: creds.user, pass: creds.pass, secret: creds.secret,
    proxy: creds.proxy, path: SEARCH_LIST_PATH, author, fields,
  });
  if (!res.ok) throw new Error(res.error || `更新に失敗しました (status ${res.status})`);
  const err = qualysActionError(res.xml ?? '');
  if (err) throw new Error(err);
}

// ──────────────────────────────────────────────────────────────────────────
// SCANレポート（ホスト単位）。launch → 完了待ち → fetch の3段。
// ★言語はアカウント設定に紐づくので、日本語/英語は creds を替えて呼ぶ。
// ──────────────────────────────────────────────────────────────────────────
const REPORT_PATH = '/api/3.0/fo/report/';

export type ReportKind = 'scan' | 'ticket';

/**
 * レポート作成を依頼して ID を返す。
 * ★チケット(Remediation)レポートは assignee_type の既定が User＝「実行者宛のチケットだけ」。
 *   指定しないと、他人に割り当てられたチケットが落ちて中身が空になる。All を明示する。
 */
export async function launchScanReport(
  creds: QualysCreds, author: string, o: { templateId: string; title: string; ip: string; kind?: ReportKind },
): Promise<string> {
  const ticket = o.kind === 'ticket';
  const res = await qualysScheduleAdd({
    base: creds.base.replace(/\/+$/, ''), user: creds.user, pass: creds.pass, secret: creds.secret,
    proxy: creds.proxy, path: REPORT_PATH, author,
    fields: {
      action: 'launch', template_id: o.templateId, report_title: o.title,
      output_format: 'pdf', report_type: ticket ? 'Remediation' : 'Scan', ips: o.ip,
      ...(ticket ? { assignee_type: 'All' } : {}),
    },
  });
  if (!res.ok) throw new Error(res.error || `レポート作成の依頼に失敗しました (status ${res.status})`);
  const xml = res.xml ?? '';
  const err = qualysActionError(xml);
  if (err) throw new Error(err);
  // SIMPLE_RETURN の ITEM_LIST に KEY=ID / VALUE=<id> で返る。
  const id = /<KEY>\s*ID\s*<\/KEY>\s*<VALUE>\s*(\d+)\s*<\/VALUE>/i.exec(xml)?.[1] ?? '';
  if (!id) throw new Error('レポートIDを取得できませんでした');
  return id;
}

/**
 * レポートの状態を**まとめて**取る。
 * ★1本ずつ id 指定で聞くと、レポートの数だけ API を叩くことになる。action=list は
 *   一覧をまとめて返すので、1回で全部の状態が分かる。
 * ★レポートは作成したアカウントのものしか見えない。日本語/英語で別アカウントを使う
 *   場合は、アカウントごとに呼ぶこと。
 */
export async function reportStates(creds: QualysCreds): Promise<Map<string, string>> {
  const base = creds.base.replace(/\/+$/, '');
  const res = await fetchQualys({
    base, url: `${base}${REPORT_PATH}?action=list`,
    user: creds.user, pass: creds.pass, secret: creds.secret, proxy: creds.proxy, noSession: true,
  });
  if (!res.ok) throw new Error(`レポートの状態を取得できません (status ${res.status})`);
  return parseReportStates(res.xml);
}

/** REPORT_LIST の応答から ID→状態。★ID と STATE は同じ REPORT の中で対にする。 */
export function parseReportStates(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml.trim()) return out;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return out; }
  for (const el of Array.from(doc.getElementsByTagName('REPORT'))) {
    const kids = Array.from(el.children);
    const id = (kids.find((c) => c.tagName === 'ID')?.textContent ?? '').trim();
    const st = kids.find((c) => c.tagName === 'STATUS');
    // STATE は STATUS の中（<STATUS><STATE>Finished</STATE></STATUS>）。直下に置く版もある。
    const state = ((st ? Array.from(st.children).find((c) => c.tagName === 'STATE')?.textContent : null)
      ?? kids.find((c) => c.tagName === 'STATE')?.textContent ?? '').trim();
    if (id) out.set(id, state);
  }
  return out;
}

/** 完成した PDF を取り出す（base64）。 */
export async function fetchReportPdf(creds: QualysCreds, id: string): Promise<string> {
  const r = await qualysReportFetch({
    base: creds.base.replace(/\/+$/, ''), user: creds.user, pass: creds.pass, secret: creds.secret,
    proxy: creds.proxy, id,
  });
  if (!r.ok || !r.base64) {
    const err = r.xml ? qualysErrorText(r.xml) : '';
    throw new Error(err || r.error || `レポートを取得できません (status ${r.status ?? '?'})`);
  }
  return r.base64;
}
