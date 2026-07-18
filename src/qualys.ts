// Qualys API ダウンロード: relay 経由でプロキシ取得し、Host の nextUrl ページングを辿って
// 全件をマージ → 正規化スナップショットにする。XML アップロードと同じ正規化(parse)に合流。
import { parseQualysXml } from './ingest/parse';
import { fetchQualys, qualysUserAdd, qualysScheduleAdd, type FetchResult } from './relay';
import { SCHEDULE_PATHS, scheduleParams, validateSchedule, type ScheduleInput } from './schedule';
import type { QamEntity, QamInspectionRaw, QamRecords, QamSnapshot } from './types';

export interface QualysCreds { base: string; user: string; pass: string; proxy: string }

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
    const r = await fetchQualys({ base, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true, url: `${base}/api/2.0/fo/asset/ip/?action=list${v.q}` });
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

// IPs in Subscription を Qualys から取得。件数と生XMLを返す（XMLは raw 保存・件数照合の検証用）。
// 取得不可（権限/エラー）なら count=null（呼び出し側で手入力値にフォールバック）。xml は取れた分を返す。
export interface IpListResult { count: number | null; xml: string }
export async function downloadIps(creds: QualysCreds): Promise<IpListResult> {
  try {
    // VM限定（compliance_enabled=0&certview_enabled=0）で取得し、VMのAddress Management 件数に一致させる。
    // フィルタ無しだと CertView/PC 区分のIPまで拾い、UI(VM)より多くなる（実測でVM限定にすると一致）。
    const base = creds.base.replace(/\/+$/, '');
    const res = await fetchQualys({ base, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true, url: `${base}/api/2.0/fo/asset/ip/?action=list&compliance_enabled=0&certview_enabled=0` });
    if (!res.ok || !res.xml) return { count: null, xml: res.xml || '' };
    return { count: countSubscriptionIps(res.xml), xml: res.xml };
  } catch { return { count: null, xml: '' }; }
}

export async function downloadEntity(kind: QamEntity, creds: QualysCreds, onProgress?: DownloadProgress): Promise<DownloadResult> {
  // 取得は Basic 認証固定。セッションCookieは環境により 401(Bad Login)で拒否され、ページ追従でも
  // 毎回 401 を出すため使わない（Basic は安定して通る）。
  const fetchPage = (body: Record<string, unknown>): Promise<FetchResult> =>
    fetchQualys({ ...body, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true });

  let res = await fetchPage({ kind, base: creds.base });
  if (!res.ok) throw new Error(`Qualys 取得失敗 (status ${res.status}): ${failReason(res) || 'アカウント権限やプロキシ設定を確認してください'}`);

  const records: QamRecords = {};
  const rawPages: string[] = [];
  const first = parseQualysXml(res.xml, kind);
  Object.assign(records, first.records);
  rawPages.push(res.xml);
  const datetime = first.datetime;
  onProgress?.({ page: 1, records: Object.keys(records).length });

  let next = res.nextUrl;
  const seen = new Set<string>([next ?? '']);
  let guard = 0;
  while (next && guard++ < 2000) {
    res = await fetchPage({ url: next });
    if (!res.ok) throw new Error(`Qualys 取得失敗(ページ ${guard}) (status ${res.status}): ${failReason(res)}`);
    Object.assign(records, parseQualysXml(res.xml, kind).records);
    rawPages.push(res.xml);
    const nx = res.nextUrl;
    // 次ページURLが進まない/既出なら暴走(同一ページの無限取得)とみなし停止。
    if (nx && seen.has(nx)) break;
    if (nx) seen.add(nx);
    next = nx;
    onProgress?.({ page: rawPages.length, records: Object.keys(records).length });
  }
  return { snapshot: { entity: kind, datetime, records }, raw: rawPages.join('\n<!-- page -->\n'), pages: rawPages.length };
}

// ──────────────────────────────────────────────────────────────────────────
// 四半期検査（SCAN/MAP の実施済み・スケジュール）の取得。
// relay は単スレッドなので順次取得する（並列にすると取りこぼす）。
// ──────────────────────────────────────────────────────────────────────────
export type InspectionProgress = (label: string) => void;

// Qualys の日時パラメータ形式 'YYYY-MM-DDTHH:MM:SSZ'（ミリ秒は付けない）。
const qualysDateTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// 1本でも取れれば表示する（エンドポイントの有無は契約/版で差があるため、全滅時だけ例外）。
export interface InspectionDownload { raw: QamInspectionRaw; warnings: string[] }

// Qualys は不正パラメータ等を HTTP 200 + <SIMPLE_RETURN><TEXT> や <ERROR> で返すことがある。
// ok だけ見ると「エラー」と「0 件」を区別できず、黙って未対応表示になるので本文も検査する。
export function qualysErrorText(xml: string): string {
  if (/<(SIMPLE|GENERIC)_RETURN/i.test(xml)) {
    const m = xml.match(/<TEXT>([\s\S]*?)<\/TEXT>/i);
    return (m ? m[1] : 'Qualys がエラーを返しました').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const e = xml.match(/<ERROR[^>]*>([\s\S]*?)<\/ERROR>/i);
  return e ? e[1].replace(/\s+/g, ' ').trim() : '';
}

export async function downloadInspection(
  creds: QualysCreds, quarterStart: Date, onProgress?: InspectionProgress,
): Promise<InspectionDownload> {
  const base = creds.base.replace(/\/+$/, '');
  const warnings: string[] = [];
  const get = async (url: string): Promise<string> => {
    const res = await fetchQualys({ base, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true, url });
    if (!res.ok || !res.xml) {
      throw new Error(`status ${res.status}: ${failReason(res) || 'アカウント権限やプロキシ設定を確認してください'}`);
    }
    const err = qualysErrorText(res.xml);
    if (err) throw new Error(err); // 200 でも本文がエラーなら失敗扱い（fallback / 警告へ）
    return res.xml;
  };
  // fallback は「絞り込みパラメータを受け付けない環境」向けの取り直し
  // （件数は増えるが四半期の判定は TS 側で行うので結果は変わらない）。
  const tryGet = async (label: string, url: string, fallback?: string): Promise<string> => {
    onProgress?.(`${label}を取得中`);
    try { return await get(url); } catch (e) {
      if (fallback) { try { return await get(fallback); } catch { /* 下の警告へ */ } }
      warnings.push(`${label}: ${(e as Error).message}`);
      return '';
    }
  };
  const after = encodeURIComponent(qualysDateTime(quarterStart));
  // show_ags=1 が無いと ASSET_GROUP_TITLE_LIST が返らない（＝対象 AssetGroup を特定できず全件が未対応になる）。
  // 公式サンプルも ?action=list&show_ags=1&show_op=1。fallback も show_ags を落とさない。
  const scanUrl = `${base}/api/2.0/fo/scan/?action=list&show_ags=1`;
  const scans = await tryGet('実施済みスキャン', `${scanUrl}&state=Finished&launched_after_datetime=${after}`, scanUrl);
  // マップは v1(MSP) にしか無い。v2 に /api/2.0/fo/map/ は存在せず 404 になる。
  // map_report_list.php が返すのは「保存されたマップレポート」＝save_report 付きで実行されたマップのみ。
  const maps = await tryGet('実施済みマップ', `${base}/msp/map_report_list.php`);
  const scanSchedules = await tryGet('スキャンのスケジュール', `${base}/api/2.0/fo/schedule/scan/?action=list`);
  // スケジュールされたマップも v1 側（type=map で一覧）。
  const mapSchedules = await tryGet('マップのスケジュール', `${base}/msp/scheduled_scans.php?type=map`);
  if (!scans && !maps && !scanSchedules && !mapSchedules) throw new Error(warnings.join(' / ') || '取得に失敗しました');
  return { raw: { scans, maps, scanSchedules, mapSchedules, fetchedAt: new Date().toISOString() }, warnings };
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
    base: creds.base.replace(/\/+$/, ''), user: creds.user, pass: creds.pass, proxy: creds.proxy,
    path: SCHEDULE_PATHS[input.kind], author, fields: scheduleParams(input),
  });
  if (res.error) throw new Error(res.error);
  const r = scheduleResult(res.xml ?? '');
  if (!r.ok) throw new Error(r.message);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${r.message}`); // 本文が読めない失敗
  return { message: r.message };
}

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
  const res = await qualysUserAdd({ base: creds.base, user: creds.user, pass: creds.pass, proxy: creds.proxy, fields });
  if (!res.ok) throw new Error(res.error || 'ユーザ登録に失敗しました');
  return { login: res.login ?? '' };
}
