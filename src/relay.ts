// relay クライアント: relay の各エンドポイントの薄いラッパ。
import { RELAY } from './config';
import type { FileBackend } from './store';

async function postJson(path: string, body: unknown): Promise<any> {
  const r = await fetch(RELAY + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// store.ts が使う FileBackend を relay /qam/file で実装。
// 大きなファイル本体は JSON で包まず「生 body」で授受する（PS5.1 の ConvertTo/From-Json は
// 大きな文字列で落ちるため）。path/append はクエリで渡す。
export const backend: FileBackend = {
  async read(path) {
    const r = await fetch(`${RELAY}/qam/file?path=${encodeURIComponent(path)}`);
    if (r.status === 404) return null; // 未存在
    if (!r.ok) throw new Error(`読込に失敗 (${path}): HTTP ${r.status}`);
    return await r.text();
  },
  async write(path, content, append) {
    const r = await fetch(`${RELAY}/qam/file?path=${encodeURIComponent(path)}&append=${append ? '1' : '0'}`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: content,
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`保存に失敗 (${path}): HTTP ${r.status}${t ? ' ' + t.slice(0, 120) : ''}`); }
  },
  async list(dir) {
    const r = await fetch(`${RELAY}/qam/file/list?dir=${encodeURIComponent(dir)}`);
    return (await r.json().catch(() => ({}))).names ?? [];
  },
  async remove(path) {
    const r = await fetch(`${RELAY}/qam/file/remove`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({} as any)); throw new Error(`削除に失敗 (${path}): ${d.error ?? 'HTTP ' + r.status}`); }
  },
};

export interface FetchResult { ok: boolean; status: number; nextUrl: string | null; xml: string; error?: string }
// Qualys 応答 XML は巨大になり得るので生 body。status/nextUrl は応答ヘッダから取る。
export async function fetchQualys(body: Record<string, unknown>): Promise<FetchResult> {
  const r = await fetch(`${RELAY}/qam/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (r.headers.get('X-QAM-Status') !== null) {
    const next = r.headers.get('X-QAM-Next');
    return { ok: r.ok, status: parseInt(r.headers.get('X-QAM-Status') || String(r.status), 10), nextUrl: next ? decodeURIComponent(next) : null, xml: text };
  }
  let err = `HTTP ${r.status}`;
  try { err = JSON.parse(text).error || err; } catch { /* ignore */ }
  return { ok: false, status: r.status, nextUrl: null, xml: '', error: err };
}

export interface SessionResult { ok: boolean; status?: number; error?: string }
export const qualysLogin = (creds: { base: string; user: string; pass: string; proxy: string }): Promise<SessionResult> => postJson('/qam/qualys/login', creds);
export const qualysLogout = (): Promise<SessionResult> => postJson('/qam/qualys/logout', {});

export interface RelayConfig { qualysBase: string; qualysUser: string; proxy: string; port: number; retentionDays: number }
export const getConfig = (): Promise<RelayConfig> => fetch(`${RELAY}/qam/config`).then((r) => r.json());
export const setConfig = async (patch: Partial<RelayConfig>): Promise<RelayConfig> => {
  const r = await fetch(`${RELAY}/qam/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  const d = await r.json().catch(() => ({} as any));
  if (!r.ok || d.error) throw new Error(`設定の保存に失敗: ${d.error ?? 'HTTP ' + r.status}`);
  return d;
};
export const shutdownRelay = (): Promise<unknown> => postJson('/qam/shutdown', {});

// 中継サーバの死活確認。起動していない/到達不能なら false（数秒でタイムアウト）。
export async function checkRelay(timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return (await fetch(`${RELAY}/qam/health`, { signal: ctrl.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(t); }
}
