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

export async function downloadEntity(kind: QamEntity, creds: QualysCreds, onProgress?: DownloadProgress): Promise<DownloadResult> {
  // セッションが 401/403 で拒否される環境では Basic に落とす。一度落ちたらラン全体（ページング含む）を
  // Basic 固定にする（ページ追従が毎回セッションに戻って 401 になるのを防ぐ）。
  let noSession = false;
  const fetchPage = async (body: Record<string, unknown>): Promise<FetchResult> => {
    let r = await fetchQualys({ ...body, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession });
    if (!r.ok && (r.status === 401 || r.status === 403) && !noSession) {
      noSession = true; // 以降は Basic 固定
      r = await fetchQualys({ ...body, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true });
    }
    return r;
  };

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
