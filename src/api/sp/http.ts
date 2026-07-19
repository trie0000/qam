// SharePoint REST の共通土台（ライブラリ実装とリスト実装で共有する）。
// 認証は同一オリジンの Cookie（`credentials: 'include'`）。したがって
// **アプリが SharePoint ページのオリジンで動いていること**が前提。
export const V = 'application/json;odata=verbose';

/** SP のエラー応答から理由を抜く（odata=verbose は error.message.value）。読めなければ空。 */
export async function errText(r: Response): Promise<string> {
  try {
    const t = await r.text();
    if (!t) return '';
    try {
      const j = JSON.parse(t);
      const m = j?.error?.message?.value ?? j?.error?.message ?? j?.['odata.error']?.message?.value;
      if (m) return ` - ${String(m).slice(0, 200)}`;
    } catch { /* JSON でなければ生テキスト */ }
    return ` - ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  } catch { return ''; }
}

/** ServerRelativeUrl やリスト名はシングルクォートで囲むので、値の ' は '' にする。 */
export const q = (s: string): string => s.replace(/'/g, "''");

export interface SpHttpOptions {
  siteUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface SpHttp {
  site: string;
  /** web のサーバ相対パス（例 /sites/xxx）。ルートサイトなら空文字。 */
  webPath: string;
  get(rel: string, accept?: string): Promise<Response>;
  /** 書き込み。要求ダイジェストを自動で付ける。 */
  post(rel: string, init?: RequestInit): Promise<Response>;
  json(r: Response): Promise<Record<string, unknown>>;
}

export function createSpHttp(o: SpHttpOptions): SpHttp {
  const f: typeof fetch = o.fetchImpl ?? ((...a) => fetch(...a));
  const now = o.now ?? (() => Date.now());
  const site = o.siteUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(site)) throw new Error('SharePoint サイト URL は http(s) から始まる絶対 URL で指定してください');
  const webPath = new URL(site).pathname.replace(/\/+$/, '');
  // ページングの __next のように絶対 URL が渡ることがあるので、その場合はそのまま使う
  // （ここを素の fetch で呼ぶと、差し替えた fetch も認証設定も迂回してしまう）。
  const api = (rel: string): string => (/^https?:\/\//i.test(rel) ? rel : `${site}/_api/${rel}`);

  // 要求ダイジェストは書き込みに必須。有効期限まで使い回す（毎回取ると往復が倍になる）。
  let digest = '';
  let digestExp = 0;
  async function getDigest(): Promise<string> {
    if (digest && now() < digestExp) return digest;
    const r = await f(api('contextinfo'), { method: 'POST', headers: { Accept: V }, credentials: 'include' });
    if (!r.ok) throw new Error(`SharePoint の要求ダイジェスト取得に失敗: HTTP ${r.status}${await errText(r)}`);
    const j = await r.json().catch(() => ({}));
    const info = j?.d?.GetContextWebInformation ?? j?.GetContextWebInformation ?? {};
    digest = String(info.FormDigestValue ?? '');
    if (!digest) throw new Error('SharePoint の要求ダイジェストを取得できませんでした（サインインを確認してください）');
    digestExp = now() + Math.max(60, Number(info.FormDigestTimeoutSeconds ?? 1800) - 60) * 1000;
    return digest;
  }

  return {
    site,
    webPath,
    get: (rel, accept = V) => f(api(rel), { headers: { Accept: accept }, credentials: 'include' }),
    async post(rel, init = {}) {
      return f(api(rel), {
        ...init,
        method: 'POST',
        credentials: 'include',
        headers: { Accept: V, 'X-RequestDigest': await getDigest(), ...(init.headers ?? {}) },
      });
    },
    async json(r) {
      const j = await r.json().catch(() => ({}));
      return (j?.d ?? j) as Record<string, unknown>;
    },
  };
}
