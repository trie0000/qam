// SharePoint のファイル URL を、REST で取りに行ける形（サイト＋サーバ相対パス）に直す。
//
// CVE対応策一覧の Excel は保管先とは別のサイトに置かれている。ブラウザのアドレス欄や
// 「パスのコピー」から貼られる URL は形がまちまちなので、ここで吸収する:
//   1. 直リンク      https://t.sharepoint.com/sites/X/Shared%20Documents/a.xlsx
//   2. 共有リンク    https://t.sharepoint.com/:x:/r/sites/X/Shared%20Documents/a.xlsx?d=w..&csf=1
//   3. ライブラリ相対 ras/a.xlsx          （保管先ライブラリからの相対＝従来どおり）
//
// ★ID 参照の共有リンク（/_layouts/15/Doc.aspx?sourcedoc={GUID}）はパスを含まないので
//   解決できない。黙って失敗させず、何を貼ればよいかを言って返す。

export interface SpFileRef {
  /** サイトの絶対 URL（例 https://t.sharepoint.com/sites/X）。 */
  site: string;
  /** サーバ相対パス（例 /sites/X/Shared Documents/a.xlsx）。 */
  serverRelativePath: string;
}

/** 絶対 URL かどうか。相対なら保管先ライブラリからの相対パスとして扱う。 */
export const isAbsoluteUrl = (v: string): boolean => /^https?:\/\//i.test((v ?? '').trim());

/**
 * SharePoint のファイル URL を解決する。解決できない形なら理由付きで投げる。
 */
export function parseSpFileUrl(raw: string): SpFileRef {
  const input = (raw ?? '').trim();
  let u: URL;
  try { u = new URL(input); } catch { throw new Error(`URL として読めません: ${input}`); }

  let path = decodeURIComponent(u.pathname);
  // 共有リンクの装飾（/:x:/r, /:w:/r, /:f:/r …）を落とす。r 以外（s=閲覧のみ等）も同じ形。
  path = path.replace(/^\/:[a-z]:\/[a-z]\//i, '/');
  if (!path.startsWith('/')) path = `/${path}`;

  if (/\/_layouts\//i.test(path)) {
    throw new Error('この URL にはファイルの場所が含まれていません（sourcedoc 形式）。ファイルを右クリック →「パスのコピー」で得られる URL を貼ってください');
  }
  if (!/\.[A-Za-z0-9]+$/.test(path)) {
    throw new Error(`ファイルの URL に見えません（拡張子がありません）: ${path}`);
  }

  // サイトは /sites/<名前> か /teams/<名前>。無ければルートサイト。
  const m = /^(\/(?:sites|teams)\/[^/]+)/i.exec(path);
  return { site: `${u.origin}${m ? m[1] : ''}`, serverRelativePath: path };
}

/** REST でファイル本体を取る URL。 */
export const spFileValueUrl = (ref: SpFileRef): string =>
  `${ref.site}/_api/web/GetFileByServerRelativeUrl('${ref.serverRelativePath.replace(/'/g, "''")}')/$value`;
