// アプリ本体（バンドル）のライブ更新。
//
// ★なぜ location.reload() ではないのか
//   このアプリは SharePoint のページに後から流し込まれている。ページを再読込すると
//   ホストページだけが読み直されてアプリは消え、そのままでは戻せない
//   （＝「更新を押したら画面が消えた」になる）。ローダと同じくバンドルを取り直して
//   eval すれば、ページはそのままで新版に入れ替わる。main.ts は起動時に既存の
//   #qam-host を消すので二重表示にはならない。
//
// 取得元はローダ（qam-launch.ps1）と同じ規則で解決する:
//   local      … <bundleLocalBase>/qam/bundle   （中継サーバ）
//   sharepoint … <サイト>/<ライブラリ>/app       （配置済みの本体）

export interface BundleLocation { base: string; from: 'local' | 'sharepoint' }

export interface BundleConfig { bundleSource?: string; bundleLocalBase?: string; spLibrary?: string }

/** サイトの web 相対パス（/sites/xxx・/teams/xxx）。ルート直下なら空文字。 */
export function webPathOf(pathname: string): string {
  const m = pathname.match(/^\/(?:sites|teams)\/[^/]+/i);
  return m ? m[0] : '';
}

export function resolveBundleLocation(cfg: BundleConfig, relayUrl: string, loc: { origin: string; pathname: string }): BundleLocation {
  if ((cfg.bundleSource ?? '').trim() === 'local') {
    const base = (cfg.bundleLocalBase || relayUrl).replace(/\/+$/, '');
    return { base: `${base}/qam/bundle`, from: 'local' };
  }
  const library = (cfg.spLibrary || 'QamData').trim();
  return { base: `${loc.origin}${webPathOf(loc.pathname)}/${encodeURIComponent(library)}/app`, from: 'sharepoint' };
}

/**
 * version.txt から版識別子を取り出す。
 * SharePoint 側は「BUILD 改行 BUILDTIME」の2行で書いているので先頭行だけを見る
 * （ビルド日時まで比べると、同じ本体でも毎回「更新あり」になってしまう）。
 */
export const buildIdOf = (text: string): string => (text || '').split('\n')[0].trim();

/** 配信元の最新版。取れなければ null（＝判定できない）。 */
export async function fetchLatestBuildId(base: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchImpl(`${base}/version.txt?t=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    return buildIdOf(await r.text()) || null;
  } catch { return null; }
}

/** 新しいバンドルを取得してその場で差し替える。成功すれば新版の起動処理まで走る。 */
export async function reloadBundleInPlace(base: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const r = await fetchImpl(`${base}/qam.bundle.js?t=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`アプリ本体を取得できません: HTTP ${r.status}`);
  const code = await r.text();
  // 壊れたもの・エラーページを eval して画面を壊さないよう、最低限の大きさは見る。
  if (!code || code.length < 1000) throw new Error(`アプリ本体が壊れています（${code.length} バイト）`);
  (0, eval)(code);
}
