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
// 書込/削除は relay 応答を必ず検査し、失敗はエラーにする（黙って 0 件 = 反映されない、を防ぐ）。
export const backend: FileBackend = {
  async read(path) {
    const r = await fetch(`${RELAY}/qam/file?path=${encodeURIComponent(path)}`);
    const d = await r.json().catch(() => ({}));
    return d.content ?? null; // 404(=未存在) は null。読みは失敗扱いしない
  },
  async write(path, content, append) {
    const r = await fetch(`${RELAY}/qam/file`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content, append: !!append }),
    });
    const d = await r.json().catch(() => ({} as any));
    if (!r.ok || d.ok === false) throw new Error(`保存に失敗 (${path}): ${d.error ?? 'HTTP ' + r.status}`);
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
export const fetchQualys = (body: Record<string, unknown>): Promise<FetchResult> => postJson('/qam/fetch', body);

export interface SessionResult { ok: boolean; status?: number; error?: string }
export const qualysLogin = (creds: { base: string; user: string; pass: string; proxy: string }): Promise<SessionResult> => postJson('/qam/qualys/login', creds);
export const qualysLogout = (): Promise<SessionResult> => postJson('/qam/qualys/logout', {});

export interface RelayConfig { qualysBase: string; qualysUser: string; proxy: string; port: number; retentionDays: number }
export const getConfig = (): Promise<RelayConfig> => fetch(`${RELAY}/qam/config`).then((r) => r.json());
export const setConfig = (patch: Partial<RelayConfig>): Promise<RelayConfig> => postJson('/qam/config', patch);
export const shutdownRelay = (): Promise<unknown> => postJson('/qam/shutdown', {});
