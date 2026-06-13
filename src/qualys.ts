// Qualys API ダウンロード: relay 経由でプロキシ取得し、Host の nextUrl ページングを辿って
// 全件をマージ → 正規化スナップショットにする。XML アップロードと同じ正規化(parse)に合流。
import { parseQualysXml } from './ingest/parse';
import { fetchQualys } from './relay';
import type { QamEntity, QamRecords, QamSnapshot } from './types';

export interface QualysCreds { base: string; user: string; pass: string; proxy: string }

export interface DownloadResult { snapshot: QamSnapshot; raw: string; pages: number }
export type DownloadProgress = (p: { page: number; records: number }) => void;

export async function downloadEntity(kind: QamEntity, creds: QualysCreds, onProgress?: DownloadProgress): Promise<DownloadResult> {
  let res = await fetchQualys({ kind, base: creds.base, user: creds.user, pass: creds.pass, proxy: creds.proxy });
  if (!res.ok) throw new Error(`Qualys 取得失敗 (status ${res.status})${res.error ? ': ' + res.error : ''}`);

  const records: QamRecords = {};
  const rawPages: string[] = [];
  const first = parseQualysXml(res.xml, kind);
  Object.assign(records, first.records);
  rawPages.push(res.xml);
  const datetime = first.datetime;
  onProgress?.({ page: 1, records: Object.keys(records).length });

  let next = res.nextUrl;
  let guard = 0;
  while (next && guard++ < 2000) {
    res = await fetchQualys({ url: next, user: creds.user, pass: creds.pass, proxy: creds.proxy });
    if (!res.ok) throw new Error(`Qualys 取得失敗(ページ ${guard}) (status ${res.status})`);
    Object.assign(records, parseQualysXml(res.xml, kind).records);
    rawPages.push(res.xml);
    next = res.nextUrl;
    onProgress?.({ page: rawPages.length, records: Object.keys(records).length });
  }
  return { snapshot: { entity: kind, datetime, records }, raw: rawPages.join('\n<!-- page -->\n'), pages: rawPages.length };
}
