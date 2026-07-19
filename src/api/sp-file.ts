// SharePoint ドキュメントライブラリを FileBackend として使う実装。
// store.ts はパス（`snapshots/host/<stamp>.json` 等）でしか物を見ないので、
// この差し替えだけで全データが SPO 上の共有になる（store.ts は無改修）。
//
// 認証は同一オリジンの Cookie（`credentials: 'include'`）。したがって
// **アプリが SharePoint ページのオリジンで動いていること**が前提になる。
// ローカル relay の画面から呼んでも SP の Cookie は付かない。
//
// 追記（append）は SPO に追記 API が無く「読む → 足す → 全文書き戻す」になるため、
// 更新も削除も無くてもロストアップデートが起きる。よって ETag の If-Match で
// 衝突を検出し、読み直して再適用する。追記専用なので解消は自明で、無条件リトライで
// 収束する（docs/SPO-MULTIUSER.md §3.1）。
import type { FileBackend } from '../store';
import { V, errText, q, createSpHttp, type SpHttp } from './sp/http';

export interface SpBackendOptions {
  siteUrl: string;              // 例: https://YOUR-TENANT.sharepoint.com/sites/YOUR-SITE
  library: string;              // ドキュメントライブラリ名（例: QamData）
  fetchImpl?: typeof fetch;     // テスト用の差し替え
  maxRetry?: number;            // 412 の再試行回数（既定 4）
  now?: () => number;           // テスト用（ダイジェストの有効期限）
  http?: SpHttp;                // 既に作ってあれば共有する（ダイジェストを使い回すため）
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function createSpBackend(o: SpBackendOptions): FileBackend {
  const http = o.http ?? createSpHttp(o);
  const base = `${http.webPath}/${o.library.trim().replace(/^\/+|\/+$/g, '')}`;
  const maxRetry = o.maxRetry ?? 4;
  const abs = (path: string): string => `${base}/${path}`.replace(/\/+$/, '');
  const fileApi = (path: string): string => `web/GetFileByServerRelativeUrl('${q(abs(path))}')`;
  const folderApi = (path: string): string => `web/GetFolderByServerRelativeUrl('${q(abs(path))}')`;

  const post = (rel: string, init: RequestInit = {}): Promise<Response> => http.post(rel, init);

  // ---- フォルダ（親から順に作る。存在すれば触らない）----
  const known = new Set<string>();
  async function ensureFolder(rel: string): Promise<void> {
    if (!rel || known.has(rel)) return;
    const parts = rel.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (known.has(cur)) continue;
      const head = await http.get(`${folderApi(cur)}?$select=Exists`);
      if (head.ok) { known.add(cur); continue; }
      if (head.status !== 404) throw new Error(`フォルダの確認に失敗 (${cur}): HTTP ${head.status}${await errText(head)}`);
      const r = await post('web/folders', {
        headers: { 'Content-Type': V },
        body: JSON.stringify({ __metadata: { type: 'SP.Folder' }, ServerRelativeUrl: abs(cur) }),
      });
      // 同時に他の人が作った場合も 200 以外になり得るので、作成後に存在を確かめる。
      if (!r.ok) {
        const again = await http.get(`${folderApi(cur)}?$select=Exists`);
        if (!again.ok) throw new Error(`フォルダの作成に失敗 (${cur}): HTTP ${r.status}${await errText(r)}`);
      }
      known.add(cur);
    }
  }

  // ---- 読み取り（本文と ETag）----
  async function readMeta(path: string): Promise<{ text: string; etag: string } | null> {
    const r = await http.get(`${fileApi(path)}/$value`, '*/*');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`読込に失敗 (${path}): HTTP ${r.status}${await errText(r)}`);
    const text = await r.text();
    let etag = r.headers.get('ETag') ?? '';
    if (!etag) {
      // $value が ETag を返さない版に備え、プロパティから取り直す（追記の If-Match に要る）。
      const p = await http.get(`${fileApi(path)}?$select=ETag`);
      if (p.ok) etag = String((await p.json().catch(() => ({})))?.d?.ETag ?? '');
    }
    return { text, etag };
  }

  const addFile = (path: string, content: string, overwrite: boolean): Promise<Response> =>
    post(`${folderApi(dirOf(path))}/Files/add(url='${q(nameOf(path))}',overwrite=${overwrite})`, {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: content,
    });

  // 既存ファイルの上書き。If-Match を付けるので、他の人が先に書いていれば 412 で弾かれる。
  const putFile = (path: string, content: string, etag: string): Promise<Response> =>
    post(`${fileApi(path)}/$value`, {
      headers: { 'Content-Type': 'text/plain;charset=utf-8', 'X-HTTP-Method': 'PUT', 'If-Match': etag || '*' },
      body: content,
    });

  return {
    async read(path) {
      const m = await readMeta(path);
      return m ? m.text : null;
    },

    async write(path, content, append) {
      await ensureFolder(dirOf(path));
      // 追記でない＝スナップショット等の不変ファイル、または全体書き換え。
      // 全文を置くだけなので読み直さない（現在のローカル実装と同じ後勝ち）。
      if (!append) {
        const r = await addFile(path, content, true);
        if (!r.ok) throw new Error(`保存に失敗 (${path}): HTTP ${r.status}${await errText(r)}`);
        return;
      }
      // 追記: SPO に追記 API は無いので read → concat → write。衝突は If-Match で検出し、
      // 読み直して自分の分を足し直す（追記専用なので何度やっても収束する）。
      for (let i = 0; i <= maxRetry; i++) {
        const cur = await readMeta(path);
        if (!cur) {
          const r = await addFile(path, content, false); // 新規作成。競合したら次周で更新に回る
          if (r.ok) return;
          if (!(await readMeta(path))) throw new Error(`保存に失敗 (${path}): HTTP ${r.status}${await errText(r)}`);
          continue;
        }
        const r = await putFile(path, cur.text + content, cur.etag);
        if (r.ok) return;
        if (r.status !== 412) throw new Error(`保存に失敗 (${path}): HTTP ${r.status}${await errText(r)}`);
      }
      throw new Error(`保存に失敗 (${path}): 他の人の書き込みと競合し続けています。時間をおいて再実行してください`);
    },

    async list(dir) {
      const names = async (kind: 'Files' | 'Folders'): Promise<string[]> => {
        const r = await http.get(`${folderApi(dir)}/${kind}?$select=Name`);
        if (r.status === 404) return [];
        if (!r.ok) throw new Error(`一覧の取得に失敗 (${dir}): HTTP ${r.status}${await errText(r)}`);
        const j = await r.json().catch(() => ({}));
        const rows = j?.d?.results ?? j?.value ?? [];
        return Array.isArray(rows) ? rows.map((x: { Name?: string }) => String(x?.Name ?? '')).filter(Boolean) : [];
      };
      return [...(await names('Files')), ...(await names('Folders'))];
    },

    async remove(path) {
      const del = (rel: string): Promise<Response> =>
        post(rel, { headers: { 'X-HTTP-Method': 'DELETE', 'If-Match': '*' } });
      const r = await del(fileApi(path));
      if (r.ok || r.status === 404) {
        if (r.ok) return;
        // ファイルとして無い場合はフォルダとして消す（剪定はディレクトリ単位でも呼ばれる）。
        const rf = await del(folderApi(path));
        if (rf.ok || rf.status === 404) return;
        throw new Error(`削除に失敗 (${path}): HTTP ${rf.status}${await errText(rf)}`);
      }
      throw new Error(`削除に失敗 (${path}): HTTP ${r.status}${await errText(r)}`);
    },
  };
}
