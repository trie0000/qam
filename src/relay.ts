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
export const backend: FileBackend = {
  async read(path) {
    const r = await fetch(`${RELAY}/qam/file?path=${encodeURIComponent(path)}`);
    const d = await r.json();
    return d.content ?? null;
  },
  write: (path, content, append) => postJson('/qam/file', { path, content, append: !!append }).then(() => undefined),
  async list(dir) {
    const r = await fetch(`${RELAY}/qam/file/list?dir=${encodeURIComponent(dir)}`);
    return (await r.json()).names ?? [];
  },
  remove: (path) => postJson('/qam/file/remove', { path }).then(() => undefined),
};

export interface FetchResult { ok: boolean; status: number; nextUrl: string | null; xml: string; error?: string }
export const fetchQualys = (body: Record<string, unknown>): Promise<FetchResult> => postJson('/qam/fetch', body);

export interface RelayConfig { qualysBase: string; qualysUser: string; proxy: string; port: number; retentionDays: number }
export const getConfig = (): Promise<RelayConfig> => fetch(`${RELAY}/qam/config`).then((r) => r.json());
export const setConfig = (patch: Partial<RelayConfig>): Promise<RelayConfig> => postJson('/qam/config', patch);
export const shutdownRelay = (): Promise<unknown> => postJson('/qam/shutdown', {});
