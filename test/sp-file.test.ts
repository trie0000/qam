import { describe, it, expect } from 'vitest';
import { createSpBackend } from '../src/api/sp-file';

// SharePoint を持たない環境で検証するため、fetch を差し替えて
// 「どの URL に・どのヘッダで・何を送ったか」と、応答に対する振る舞いを確かめる。
interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

interface Rule { match: RegExp; method?: string; res: () => Response | Promise<Response> }

const json = (obj: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(obj), { status: 200, ...init });

function stub(rules: Rule[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    for (const r of rules) {
      if (r.match.test(url) && (!r.method || r.method === method)) return r.res();
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const DIGEST: Rule = { match: /_api\/contextinfo$/, method: 'POST', res: () => json({ d: { GetContextWebInformation: { FormDigestValue: 'DIGEST', FormDigestTimeoutSeconds: 1800 } } }) };
const FOLDER_OK: Rule = { match: /GetFolderByServerRelativeUrl\([^)]*\)\?\$select=Exists/, res: () => json({ d: { Exists: true } }) };

const make = (rules: Rule[], maxRetry = 4) => {
  const s = stub([DIGEST, FOLDER_OK, ...rules]);
  return { ...s, be: createSpBackend({ siteUrl: 'https://example.sharepoint.com/sites/qa', library: 'QamData', fetchImpl: s.fetchImpl, maxRetry }) };
};

describe('SharePoint ライブラリ保管', () => {
  it('サイト URL とライブラリ名からサーバ相対パスを組む', async () => {
    const { be, calls } = make([{ match: /\$value$/, res: () => new Response('hello', { status: 200, headers: { ETag: '"1"' } }) }]);
    expect(await be.read('snapshots/host/a.json')).toBe('hello');
    expect(calls[0].url).toContain("GetFileByServerRelativeUrl('/sites/qa/QamData/snapshots/host/a.json')/$value");
  });

  it('存在しないファイルは null（404 を例外にしない）', async () => {
    const { be } = make([{ match: /\$value$/, res: () => new Response('', { status: 404 }) }]);
    expect(await be.read('history/host.jsonl')).toBeNull();
  });

  it('読めない場合は理由を添えて投げる', async () => {
    const { be } = make([{ match: /\$value$/, res: () => new Response(JSON.stringify({ error: { message: { value: 'Access denied' } } }), { status: 403 }) }]);
    await expect(be.read('a.json')).rejects.toThrow(/403.*Access denied/);
  });

  it('新規作成は overwrite=true の add（追記でない書き込み）', async () => {
    const { be, calls } = make([{ match: /Files\/add/, method: 'POST', res: () => json({}) }]);
    await be.write('snapshots/host/a.json', '{"x":1}', false);
    const add = calls.find((c) => c.url.includes('Files/add'))!;
    expect(add.url).toContain("GetFolderByServerRelativeUrl('/sites/qa/QamData/snapshots/host')/Files/add(url='a.json',overwrite=true)");
    expect(add.body).toBe('{"x":1}');
    expect(add.headers['X-RequestDigest']).toBe('DIGEST');
  });

  it('追記は 既存本文 + 追記分 を If-Match 付きで書き戻す', async () => {
    const { be, calls } = make([
      { match: /\$value$/, method: 'GET', res: () => new Response('a\n', { status: 200, headers: { ETag: '"3"' } }) },
      { match: /\$value$/, method: 'POST', res: () => json({}) },
    ]);
    await be.write('history/host.jsonl', 'b\n', true);
    const put = calls.find((c) => c.method === 'POST' && c.url.endsWith('/$value'))!;
    expect(put.headers['X-HTTP-Method']).toBe('PUT');
    expect(put.headers['If-Match']).toBe('"3"');
    expect(put.body).toBe('a\nb\n'); // 既存を消さずに足す
  });

  it('412（他の人が先に書いた）なら読み直して自分の分を足し直す', async () => {
    let reads = 0;
    let puts = 0;
    const { be } = make([
      { match: /\$value$/, method: 'GET', res: () => { reads++; return new Response(reads === 1 ? 'a\n' : 'a\nX\n', { status: 200, headers: { ETag: `"${reads}"` } }); } },
      { match: /\$value$/, method: 'POST', res: () => { puts++; return puts === 1 ? new Response('', { status: 412 }) : json({}); } },
    ]);
    await be.write('history/host.jsonl', 'b\n', true);
    // 1 回目は弾かれ、2 回目は「他の人の X を含む最新」に対して追記されている
    expect(reads).toBe(2);
    expect(puts).toBe(2);
  });

  it('競合が続けば諦めて明示的に失敗する（無限ループにしない）', async () => {
    const { be } = make([
      { match: /\$value$/, method: 'GET', res: () => new Response('a\n', { status: 200, headers: { ETag: '"1"' } }) },
      { match: /\$value$/, method: 'POST', res: () => new Response('', { status: 412 }) },
    ], 1);
    await expect(be.write('history/host.jsonl', 'b\n', true)).rejects.toThrow(/競合/);
  });

  it('追記先が無ければ overwrite=false で作る（同時作成を上書きしない）', async () => {
    const { be, calls } = make([
      { match: /\$value$/, method: 'GET', res: () => new Response('', { status: 404 }) },
      { match: /Files\/add/, method: 'POST', res: () => json({}) },
    ]);
    await be.write('ops.jsonl', 'x\n', true);
    expect(calls.find((c) => c.url.includes('Files/add'))!.url).toContain('overwrite=false');
  });

  it('一覧はファイルとフォルダの両方の名前を返す', async () => {
    const { be } = make([
      { match: /\/Files\?\$select=Name/, res: () => json({ d: { results: [{ Name: '2026-07-18.json' }, { Name: '2026-07-19.json' }] } }) },
      { match: /\/Folders\?\$select=Name/, res: () => json({ d: { results: [{ Name: 'sub' }] } }) },
    ]);
    expect(await be.list('snapshots/host')).toEqual(['2026-07-18.json', '2026-07-19.json', 'sub']);
  });

  it('一覧の対象が無ければ空配列（未取込を例外にしない）', async () => {
    const { be } = make([{ match: /\/(Files|Folders)\?\$select=Name/, res: () => new Response('', { status: 404 }) }]);
    expect(await be.list('snapshots/host')).toEqual([]);
  });

  it('削除はファイル→フォルダの順に試す', async () => {
    const { be, calls } = make([
      { match: /GetFileByServerRelativeUrl/, method: 'POST', res: () => new Response('', { status: 404 }) },
      { match: /GetFolderByServerRelativeUrl\('[^']*'\)$/, method: 'POST', res: () => json({}) },
    ]);
    await be.remove('snapshots/host');
    const dels = calls.filter((c) => c.headers['X-HTTP-Method'] === 'DELETE');
    expect(dels).toHaveLength(2);
    expect(dels[0].url).toContain('GetFileByServerRelativeUrl');
    expect(dels[1].url).toContain('GetFolderByServerRelativeUrl');
  });

  it('要求ダイジェストは使い回す（書き込みのたびに取り直さない）', async () => {
    const { be, calls } = make([{ match: /Files\/add/, method: 'POST', res: () => json({}) }]);
    await be.write('a.json', '1', false);
    await be.write('b.json', '2', false);
    expect(calls.filter((c) => c.url.endsWith('/_api/contextinfo'))).toHaveLength(1);
  });

  it('サイト URL が絶対 URL でなければ生成時に弾く', () => {
    expect(() => createSpBackend({ siteUrl: '/sites/qa', library: 'QamData' })).toThrow(/絶対 URL/);
  });
});
