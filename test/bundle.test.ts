import { describe, it, expect, vi } from 'vitest';
import { resolveBundleLocation, webPathOf, buildIdOf, fetchLatestBuildId, reloadBundleInPlace } from '../src/bundle';

const loc = (pathname: string, origin = 'https://example.sharepoint.com') => ({ origin, pathname });
// eval される本体なので JS として正しいものを渡す（サイズ下限を超える長さにする）。
const PAD = `/* ${'pad '.repeat(400)} */`;
const okBundle = (): typeof fetch => vi.fn(async () => new Response(PAD)) as unknown as typeof fetch;
const RELAY = 'http://127.0.0.1:18090';

describe('バンドル取得元の解決', () => {
  it('サイトの web 相対パスを取り出す（sites / teams 両方）', () => {
    expect(webPathOf('/sites/qa/SitePages/Home.aspx')).toBe('/sites/qa');
    expect(webPathOf('/teams/net/Lists/x')).toBe('/teams/net');
    expect(webPathOf('/SitePages/Home.aspx')).toBe(''); // ルートサイト
  });

  it('SharePoint 配信はライブラリ配下の app を見る（ローダと同じ場所）', () => {
    const r = resolveBundleLocation({ spLibrary: 'QamData' }, RELAY, loc('/sites/qa/SitePages/Home.aspx'));
    expect(r).toEqual({ base: 'https://example.sharepoint.com/sites/qa/QamData/app', from: 'sharepoint' });
  });

  it('ライブラリ未設定なら既定の QamData', () => {
    expect(resolveBundleLocation({}, RELAY, loc('/sites/qa/x')).base).toBe('https://example.sharepoint.com/sites/qa/QamData/app');
  });

  it('local 指定なら中継サーバの /qam/bundle を見る', () => {
    const r = resolveBundleLocation({ bundleSource: 'local', bundleLocalBase: 'http://127.0.0.1:18777/' }, RELAY, loc('/sites/qa/x'));
    expect(r).toEqual({ base: 'http://127.0.0.1:18777/qam/bundle', from: 'local' });
  });

  it('local 指定で base 未設定なら relay の URL を使う', () => {
    expect(resolveBundleLocation({ bundleSource: 'local' }, RELAY, loc('/sites/qa/x')).base).toBe(`${RELAY}/qam/bundle`);
  });
});

describe('版の比較', () => {
  it('version.txt は先頭行だけを版とみなす', () => {
    // ★SharePoint 側は「BUILD 改行 BUILDTIME」で書いている。ビルド日時まで比べると
    //   同じ本体でも毎回「更新あり」になってしまう。
    expect(buildIdOf('a6d7fbd1ddea\n2026-08-16 17:34 JST\n')).toBe('a6d7fbd1ddea');
    expect(buildIdOf('a6d7fbd1ddea')).toBe('a6d7fbd1ddea');
    expect(buildIdOf('')).toBe('');
  });

  it('version.txt が取れなければ null（判定できない＝更新扱いにしない）', async () => {
    const f = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchLatestBuildId('https://x/app', f)).toBeNull();
  });

  it('通信自体が失敗しても例外を投げない', async () => {
    const f = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchLatestBuildId('https://x/app', f)).toBeNull();
  });

  it("credentials は same-origin（include だと中継サーバから読む構成で必ず失敗する）", async () => {
    // ★中継サーバは Access-Control-Allow-Credentials を返さないので、'include' だと
    //   ブラウザが応答を捨てて Failed to fetch になる（実測）。
    const calls: RequestInit[] = [];
    const f = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init ?? {}); return new Response('abc\n'); }) as unknown as typeof fetch;
    await fetchLatestBuildId('https://x/app', f);
    await reloadBundleInPlace('https://x/app', okBundle());
    expect(calls[0].credentials).toBe('same-origin');
  });

  it('本体の取得も same-origin', async () => {
    const calls: RequestInit[] = [];
    const f = vi.fn(async (_u: string, init?: RequestInit) => { calls.push(init ?? {}); return new Response(PAD); }) as unknown as typeof fetch;
    await reloadBundleInPlace('https://x/app', f);
    expect(calls[0].credentials).toBe('same-origin');
  });

  it('キャッシュを無効化して取りに行く（古い版を掴み続けないため）', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = vi.fn(async (u: string, init?: RequestInit) => { calls.push([u, init]); return new Response('abc\n'); }) as unknown as typeof fetch;
    await fetchLatestBuildId('https://x/app', f);
    expect(calls[0][0]).toMatch(/^https:\/\/x\/app\/version\.txt\?t=\d+$/);
    expect(calls[0][1]?.cache).toBe('no-store');
  });
});

describe('バンドルの差し替え', () => {
  it('取得に失敗したら eval せず失敗させる', async () => {
    const f = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(reloadBundleInPlace('https://x/app', f)).rejects.toThrow(/HTTP 500/);
  });

  it('小さすぎる応答は eval しない（エラーページを実行して画面を壊さない）', async () => {
    const f = vi.fn(async () => new Response('<html>error</html>')) as unknown as typeof fetch;
    await expect(reloadBundleInPlace('https://x/app', f)).rejects.toThrow(/壊れています/);
  });

  it('正常な本体は eval される', async () => {
    const code = `globalThis.__qamTestLoaded = true;${'/*pad*/'.repeat(200)}`;
    const f = vi.fn(async () => new Response(code)) as unknown as typeof fetch;
    await reloadBundleInPlace('https://x/app', f);
    expect((globalThis as Record<string, unknown>).__qamTestLoaded).toBe(true);
  });
});
