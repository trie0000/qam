// Qualys API ダウンロード: relay 経由でプロキシ取得し、Host の nextUrl ページングを辿って
// 全件をマージ → 正規化スナップショットにする。XML アップロードと同じ正規化(parse)に合流。
import { parseQualysXml } from './ingest/parse';
import { fetchQualys, type FetchResult } from './relay';
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

// IPs in Subscription を Qualys から取得（/api/2.0/fo/asset/ip/?action=list）。
// 応答中の <IP> は1、<IP_RANGE>a-b</IP_RANGE> は (b-a+1) を加算して登録IP総数を数える。
// 取得不可（権限/エラー）なら null（呼び出し側で手入力値にフォールバック）。
export async function downloadIpCount(creds: QualysCreds): Promise<number | null> {
  try {
    const res = await fetchQualys({ kind: 'ips', base: creds.base, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true });
    if (!res.ok || !res.xml) return null;
    const xml = res.xml;
    let n = 0;
    for (const m of xml.matchAll(/<IP(?:\s[^>]*)?>([^<]+)<\/IP>/gi)) { if (ipToInt(m[1]) !== null) n += 1; }
    for (const m of xml.matchAll(/<IP_RANGE(?:\s[^>]*)?>([^<]+)<\/IP_RANGE>/gi)) {
      const [a, b] = m[1].split('-').map((x) => x.trim());
      const ai = ipToInt(a); const bi = ipToInt(b);
      if (ai !== null && bi !== null && bi >= ai) n += bi - ai + 1;
    }
    return n;
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
