import { describe, it, expect } from 'vitest';
import { createSpRepo } from '../src/api/sp-repo';
import { createSpListClient, type SpItem, type SpListClient } from '../src/api/sp/list';
import { LIST_ANNOTATIONS, LIST_COMMENTS, LIST_LICENSES, LIST_SETTINGS, LOCK_INGEST, annotKey } from '../src/api/sp/schema';

// リストを模した最小の実装。行の追加/更新/削除がそのまま観測できる。
function fakeLists(seed: Record<string, SpItem[]> = {}): SpListClient & { rows: Record<string, SpItem[]>; ensured: string[] } {
  const rows: Record<string, SpItem[]> = { ...seed };
  const ensured: string[] = [];
  let nextId = 100;
  return {
    rows,
    ensured,
    ensureList: async (t) => { ensured.push(t); rows[t] ??= []; },
    all: async (t) => (rows[t] ?? []).map((r) => ({ ...r })),
    add: async (t, row) => {
      const list = (rows[t] ??= []);
      // 一意制約の再現: DedupKey が重なったら弾く（SP の EnforceUniqueValues 相当）。
      if (row.DedupKey && list.some((r) => r.DedupKey === row.DedupKey)) throw new Error('duplicate');
      list.push({ ...row, Id: nextId++, __etag: '"1"' });
    },
    update: async (t, id, row, etag) => {
      const hit = (rows[t] ?? []).find((r) => r.Id === id);
      if (!hit) return false;
      if (etag && hit.__etag !== etag) return false; // 412 相当
      Object.assign(hit, row, { __etag: `"${Number(hit.__etag.replace(/\D/g, '')) + 1}"` });
      return true;
    },
    remove: async (t, id) => { rows[t] = (rows[t] ?? []).filter((r) => r.Id !== id); },
  };
}

const repoOf = (lists: SpListClient, now?: () => number) =>
  createSpRepo({ siteUrl: 'https://example.sharepoint.com/sites/qa', listClient: lists, now });

describe('SharePoint リスト実装（記録系）', () => {
  it('必要なリストを作る', async () => {
    const lists = fakeLists();
    await repoOf(lists).ensureLists();
    expect(lists.ensured).toContain(LIST_COMMENTS);
    expect(lists.ensured).toContain(LIST_ANNOTATIONS);
    expect(lists.ensured).toContain(LIST_SETTINGS); // 共有設定＋排他クレーム行
    expect(lists.ensured).toHaveLength(6);
  });

  it('メモは行として足され、entity+id で絞れる', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.addComment({ ts: 't1', entity: 'host', id: 'h1', author: '田中', text: 'あ' });
    await repo.addComment({ ts: 't2', entity: 'group', id: 'g1', author: '田中', text: 'い' });
    expect(await repo.readComments('host')).toHaveLength(1);
    expect((await repo.readComments('host', 'h1'))[0].text).toBe('あ');
    expect(await repo.readComments()).toHaveLength(2);
  });

  it('メモの編集は該当行だけを更新する（他の行に触らない）', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.addComment({ ts: 't1', entity: 'host', id: 'h1', author: 'a', text: '旧' });
    await repo.addComment({ ts: 't2', entity: 'host', id: 'h1', author: 'b', text: 'そのまま' });
    await repo.editComment('host', 'h1', 't1', '新');
    const got = await repo.readComments('host', 'h1');
    expect(got.find((c) => c.ts === 't1')!.text).toBe('新');
    expect(got.find((c) => c.ts === 't2')!.text).toBe('そのまま');
  });

  it('注釈は資産×項目で1行。既存があれば追加せず更新する', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.setAnnotation('group', 'g1', 'Function', 'web');
    await repo.setAnnotation('group', 'g1', 'Function', 'api'); // 上書き
    await repo.setAnnotation('group', 'g1', 'Location', '東京');
    expect(lists.rows[LIST_ANNOTATIONS]).toHaveLength(2); // 行が増えない
    expect(await repo.readAnnotations('group')).toEqual({ g1: { Function: 'api', Location: '東京' } });
  });

  it('空文字は削除（ファイル実装と同じ意味）', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.setAnnotation('group', 'g1', 'Function', 'web');
    await repo.setAnnotation('group', 'g1', 'Function', '');
    expect(lists.rows[LIST_ANNOTATIONS]).toHaveLength(0);
    expect(await repo.readAnnotations('group')).toEqual({});
  });

  it('同じ項目を他の人が先に作っていたら、重複を作らず更新に回る', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    // 読み取り時点では無いが、add の瞬間に他の人の行がある状況を作る
    const origAll = lists.all.bind(lists);
    let first = true;
    lists.all = async (t) => {
      const rows = await origAll(t);
      if (t === LIST_ANNOTATIONS && first) { first = false; return []; } // 1周目は「無い」と見える
      return rows;
    };
    lists.rows[LIST_ANNOTATIONS] = [{ Id: 1, __etag: '"1"', Entity: 'group', TargetId: 'g1', FieldName: 'F', Value: '他人', DedupKey: annotKey('group', 'g1', 'F') }];
    await repo.setAnnotation('group', 'g1', 'F', '自分');
    expect(lists.rows[LIST_ANNOTATIONS]).toHaveLength(1); // 二重に増えない
    expect(lists.rows[LIST_ANNOTATIONS][0].Value).toBe('自分');
  });

  it('412（他の人が先に更新）なら読み直して適用し直す', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.setAnnotation('group', 'g1', 'F', 'v1');
    // 手元の etag を古いままにして更新させる → 1度弾かれ、読み直して成功する
    const hit = lists.rows[LIST_ANNOTATIONS][0];
    hit.__etag = '"9"';
    await repo.setAnnotation('group', 'g1', 'F', 'v2');
    expect(lists.rows[LIST_ANNOTATIONS][0].Value).toBe('v2');
  });

  it('一括反映は全体を1回読んでから行単位で適用する', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.setAnnotationsBulk('group', [
      { id: 'g1', field: 'F', value: 'a' },
      { id: 'g2', field: 'F', value: 'b' },
      { id: 'g1', field: 'L', value: 'c' },
    ]);
    expect(await repo.readAnnotations('group')).toEqual({ g1: { F: 'a', L: 'c' }, g2: { F: 'b' } });
  });

  it('管理表は配列と provision を往復できる', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    const m = {
      ts: '2026-07-19T00:00:00Z', author: 'a', mode: 'ledger' as const, kind: 'map' as const,
      title: 'X(仮)_m_20260801', nextLaunch: '2026-08-01T02:00:00',
      assetGroups: ['X(仮)'], domains: ['x.jp', 'y.jp'], subject: '件名',
      provision: { applicationNo: 'X', assets: [{ value: '203.0.113.1', scan: true, map: true }] },
    };
    await repo.appendManualInspection(m);
    expect((await repo.readManualInspections())[0]).toMatchObject({
      title: m.title, kind: 'map', mode: 'ledger', domains: ['x.jp', 'y.jp'], assetGroups: ['X(仮)'],
      subject: '件名', provision: m.provision,
    });
  });

  it('ライセンス推移は同一 ts をまとめる（ips を後から埋める運用に対応）', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.recordLicense('2026-07-19', 0, 120);
    await repo.recordLicense('2026-07-19', 500, 0);
    expect(await repo.readLicenses()).toEqual([{ ts: '2026-07-19', ips: 500, scanned: 120 }]);
  });

  it('操作履歴は entity 無しでも往復できる', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.logOp({ ts: 't', author: 'a', action: '取込', detail: 'host' });
    await repo.logOp({ ts: 't2', author: 'a', action: '削除', entity: 'group', detail: 'g1' });
    const ops = await repo.readOps();
    expect(ops[0].entity).toBeUndefined();
    expect(ops[1].entity).toBe('group');
  });
});

// --- リストクライアント本体（fetch を差し替えて URL 形状と分岐を見る）---
describe('SharePoint リストクライアント', () => {
  const V = 'application/json;odata=verbose';
  const mk = (handler: (url: string, init?: RequestInit) => Response) => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(u), method: (init?.method ?? 'GET').toUpperCase(), headers: (init?.headers ?? {}) as Record<string, string> });
      if (String(u).endsWith('/_api/contextinfo')) {
        return new Response(JSON.stringify({ d: { GetContextWebInformation: { FormDigestValue: 'D', FormDigestTimeoutSeconds: 1800 } } }), { status: 200 });
      }
      return handler(String(u), init);
    }) as unknown as typeof fetch;
    return { calls, client: createSpListClient({ siteUrl: 'https://example.sharepoint.com/sites/qa', fetchImpl }) };
  };

  it('未作成のリストは 0 件として返す（初回起動で落ちない）', async () => {
    const { client } = mk(() => new Response('', { status: 404 }));
    expect(await client.all('QamOps')).toEqual([]);
  });

  it('__next を辿って全件取得する', async () => {
    let page = 0;
    const { client } = mk((url) => {
      if (!/\/items/.test(url)) return new Response('', { status: 404 });
      page++;
      return new Response(JSON.stringify(page === 1
        ? { d: { results: [{ Id: 1, __metadata: { etag: '"1"' } }], __next: "https://example.sharepoint.com/sites/qa/_api/web/lists/getbytitle('QamOps')/items?$skiptoken=x" } }
        : { d: { results: [{ Id: 2, __metadata: { etag: '"1"' } }] } }), { status: 200 });
    });
    const items = await client.all('QamOps');
    expect(items.map((i) => i.Id)).toEqual([1, 2]);
  });

  it('更新は MERGE + If-Match。412 は false（例外にしない）', async () => {
    const { client, calls } = mk((url) => {
      if (/\?\$select=ListItemEntityTypeFullName/.test(url)) return new Response(JSON.stringify({ d: { ListItemEntityTypeFullName: 'SP.Data.QamOpsListItem' } }), { status: 200 });
      return new Response('', { status: 412 });
    });
    expect(await client.update('QamOps', 5, { Detail: 'x' }, '"7"')).toBe(false);
    const merge = calls.find((c) => c.headers['X-HTTP-Method'] === 'MERGE')!;
    expect(merge.url).toContain("getbytitle('QamOps')/items(5)");
    expect(merge.headers['If-Match']).toBe('"7"');
    expect(merge.headers.Accept).toBe(V);
  });

  it('リストが無ければ作ってから列を足す', async () => {
    const created: string[] = [];
    const { client } = mk((url, init) => {
      if (/getbytitle\('QamOps'\)\?\$select=Id/.test(url)) return new Response('', { status: 404 });
      if (/web\/lists$/.test(url)) { created.push('list'); return new Response(JSON.stringify({ d: {} }), { status: 201 }); }
      if (/\/fields\?\$select=/.test(url)) return new Response(JSON.stringify({ d: { results: [] } }), { status: 200 });
      if (/\/fields$/.test(url)) { created.push(JSON.parse(String(init?.body)).Title); return new Response(JSON.stringify({ d: {} }), { status: 201 }); }
      return new Response(JSON.stringify({ d: {} }), { status: 200 });
    });
    await client.ensureList('QamOps', [{ name: 'Ts', type: 'Text', indexed: true }, { name: 'Detail', type: 'Note' }]);
    expect(created).toEqual(['list', 'Ts', 'Detail']);
  });
});

describe('取込ロック（重複取込の抑止）', () => {
  const T0 = Date.parse('2026-07-19T10:00:00Z');

  it('誰も取っていなければ取れる（行が1本できる）', async () => {
    const lists = fakeLists();
    expect(await repoOf(lists, () => T0).acquireIngestLock('田中', 15)).toBeNull();
    const row = lists.rows[LIST_SETTINGS][0];
    expect(row.SettingKey).toBe(LOCK_INGEST);
    expect(row.Owner).toBe('田中');
  });

  it('他の人が取込中なら保持者を返す（取れない）', async () => {
    const lists = fakeLists();
    await repoOf(lists, () => T0).acquireIngestLock('田中', 15);
    const held = await repoOf(lists, () => T0 + 60_000).acquireIngestLock('鈴木', 15);
    expect(held).toMatchObject({ owner: '田中' });
    expect(lists.rows[LIST_SETTINGS]).toHaveLength(1); // 行は増えない
  });

  it('同時に取りに来ても、行を作れるのは1人だけ（一意制約）', async () => {
    const lists = fakeLists();
    // 2人とも「行が無い」と見えた状態から add する
    const a = repoOf(lists, () => T0);
    const b = repoOf(lists, () => T0);
    const [r1, r2] = [await a.acquireIngestLock('田中', 15), await b.acquireIngestLock('鈴木', 15)];
    expect(lists.rows[LIST_SETTINGS]).toHaveLength(1);
    // 先に取れた方が null、もう片方は保持者を受け取る
    expect([r1, r2].filter((x) => x === null)).toHaveLength(1);
    expect([r1, r2].find((x) => x !== null)).toMatchObject({ owner: '田中' });
  });

  it('期限切れの行は引き継げる（閉じっぱなしで詰まらない）', async () => {
    const lists = fakeLists();
    await repoOf(lists, () => T0).acquireIngestLock('田中', 15);
    const later = T0 + 16 * 60_000; // TTL 経過後
    expect(await repoOf(lists, () => later).acquireIngestLock('鈴木', 15)).toBeNull();
    expect(lists.rows[LIST_SETTINGS][0].Owner).toBe('鈴木');
  });

  it('解放は自分の行だけ。引き継がれた後は他人の行を消さない', async () => {
    const lists = fakeLists();
    const tanaka = repoOf(lists, () => T0);
    await tanaka.acquireIngestLock('田中', 15);
    await repoOf(lists, () => T0 + 16 * 60_000).acquireIngestLock('鈴木', 15); // 期限切れで引き継ぎ
    await tanaka.releaseIngestLock('田中'); // 遅れて田中が解放しにくる
    expect(lists.rows[LIST_SETTINGS]).toHaveLength(1);
    expect(lists.rows[LIST_SETTINGS][0].Owner).toBe('鈴木'); // 鈴木のロックは残る
  });

  it('自分の行は解放できる', async () => {
    const lists = fakeLists();
    const r = repoOf(lists, () => T0);
    await r.acquireIngestLock('田中', 15);
    await r.releaseIngestLock('田中');
    expect(lists.rows[LIST_SETTINGS]).toHaveLength(0);
  });
});
