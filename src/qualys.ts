// Qualys API ダウンロード: relay 経由でプロキシ取得し、Host の nextUrl ページングを辿って
// 全件をマージ → 正規化スナップショットにする。XML アップロードと同じ正規化(parse)に合流。
import { parseQualysXml } from './ingest/parse';
import { fetchQualys } from './relay';
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
  let res = await fetchQualys({ kind, base: creds.base, user: creds.user, pass: creds.pass, proxy: creds.proxy });
  // 401/403: セッションのスコープ不足の可能性（user 一覧は権限が厳しめ）。Basic 認証で1度だけ再試行。
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    res = await fetchQualys({ kind, base: creds.base, user: creds.user, pass: creds.pass, proxy: creds.proxy, noSession: true });
  }
  if (!res.ok) throw new Error(`Qualys 取得失敗 (status ${res.status}): ${failReason(res) || 'アカウント権限（特に user 一覧は Manager 権限が必要）やプロキシ設定を確認してください'}`);

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
    res = await fetchQualys({ url: next, user: creds.user, pass: creds.pass, proxy: creds.proxy });
    if (!res.ok) throw new Error(`Qualys 取得失敗(ページ ${guard}) (status ${res.status})`);
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
