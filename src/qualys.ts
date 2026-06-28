// Qualys API ダウンロード: relay 経由でプロキシ取得し、Host の nextUrl ページングを辿って
// 全件をマージ → 正規化スナップショットにする。XML アップロードと同じ正規化(parse)に合流。
import { parseQualysXml } from './ingest/parse';
import { fetchQualys, qualysUserAdd, type FetchResult } from './relay';
import type { QamEntity, QamRecords, QamSnapshot } from './types';

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

// IPs in Subscription を Qualys から取得。取得不可（権限/エラー）なら null（呼び出し側で手入力値にフォールバック）。
export async function downloadIpCount(creds: QualysCreds): Promise<number | null> {
  try {
    const res = await fetchQualys({ kind: 'ips', base: creds.base, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true });
    if (!res.ok || !res.xml) return null;
    return countSubscriptionIps(res.xml);
  } catch { return null; }
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
