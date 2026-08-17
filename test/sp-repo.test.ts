import { describe, it, expect } from 'vitest';
import { createSpRepo } from '../src/api/sp-repo';
import { createSpListClient, type SpItem, type SpListClient } from '../src/api/sp/list';
import { ALL_LISTS, LIST_ANNOTATIONS, LIST_COMMENTS, LIST_LICENSES, LIST_SETTINGS, LOCK_INGEST, LIST_RAS_ASSETS, LIST_RAS_TICKETS, annotKey } from '../src/api/sp/schema';

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
      // 一意制約の再現: DedupKey（資産等）と Title（チケット）の重複を弾く。
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
    viewUrl: async (t) => `https://example.sharepoint.com/sites/qa/Lists/${t}/AllItems.aspx`,
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
    // 独自RAS はアイテム単位でアクセス権を分けるので、専用のリストが要る。
    expect(lists.ensured).toContain(LIST_RAS_ASSETS);
    expect(lists.ensured).toContain(LIST_RAS_TICKETS);
    expect(lists.ensured).toHaveLength(8);
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

describe('独自RAS のリスト同期', () => {
  const asset = (hostId: string, ip: string, company = '') =>
    ({ key: hostId, hostId, settenId: 'R100', ip, fqdn: `${hostId}.example`, status: '', trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: company, managementCompany: '' });

  it('資産は追加・更新・削除される', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.syncRasAssets([asset('1', '10.0.0.1'), asset('2', '10.0.0.2')]);
    expect(lists.rows[LIST_RAS_ASSETS]).toHaveLength(2);
    // 1 は IP 変更 / 2 は Qualys から消えた / 3 は新規
    const r = await repo.syncRasAssets([asset('1', '10.0.0.9'), asset('3', '10.0.0.3')]);
    expect(r).toEqual({ added: 1, updated: 1, removed: 1 });
    expect((lists.rows[LIST_RAS_ASSETS] ?? []).map((x) => x.HostId).sort()).toEqual(['1', '3']);
  });

  it('変化が無ければ書き込まない（版数を無駄に増やさない）', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.syncRasAssets([asset('1', '10.0.0.1')]);
    const before = lists.rows[LIST_RAS_ASSETS][0].__etag;
    const r = await repo.syncRasAssets([asset('1', '10.0.0.1')]);
    expect(r).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(lists.rows[LIST_RAS_ASSETS][0].__etag).toBe(before);
  });

  it('事業会社を登録しても取込で消えない（同期は登録値をそのまま書く）', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.syncRasAssets([asset('1', '10.0.0.1')]);
    await repo.setRasCompany('1', 'A社', 'B保守');
    expect(lists.rows[LIST_RAS_ASSETS][0].BusinessCompany).toBe('A社');
    // 呼び出し側が引き継いだ値で同期する（deriveRasAssets が既存値を持ってくる）
    await repo.syncRasAssets([{ ...asset('1', '10.0.0.1', 'A社'), managementCompany: 'B保守' }]);
    expect(lists.rows[LIST_RAS_ASSETS][0].BusinessCompany).toBe('A社');
    expect(lists.rows[LIST_RAS_ASSETS][0].ManagementCompany).toBe('B保守');
  });

  it('チケットは載っていない分を消さない', async () => {
    // ★取得が「直近1ヶ月の変化分」のことがある。消すと、動きが無かっただけの
    //   オープン中チケットが毎回消えてしまう。
    const lists = fakeLists();
    const repo = repoOf(lists);
    const t = (n: string, state = 'OPEN') =>
      ({ number: n, state, hostId: '1', ip: '10.0.0.1', fqdn: 'a', settenId: 'R100', businessCompany: 'A社', managementCompany: '',
         created: '', firstFound: '2026-08-01 00:00:00', lastFound: '' });
    await repo.syncRasTickets([t('11'), t('12')]);
    const r = await repo.syncRasTickets([t('11', 'CLOSED')]);
    expect(r).toEqual({ added: 0, updated: 1, removed: 0 });
    // チケット番号は Title に入る（TicketNumber 列は持たない）。
    expect((lists.rows[LIST_RAS_TICKETS] ?? []).map((x) => x.Title).sort()).toEqual(['11', '12']);
    expect(lists.rows[LIST_RAS_TICKETS].find((x) => x.Title === '11')!.State).toBe('CLOSED');
  });

  it('共有 JSON は設定リストの1行に入り、読み書きできる', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    expect(await repo.readSharedJson('ras:perms', { adminGroupIds: [] })).toEqual({ adminGroupIds: [] });
    await repo.writeSharedJson('ras:perms', { adminGroupIds: [5] });
    expect(await repo.readSharedJson('ras:perms', null)).toEqual({ adminGroupIds: [5] });
    await repo.writeSharedJson('ras:perms', { adminGroupIds: [6] }); // 上書き（行は増やさない）
    expect((lists.rows[LIST_SETTINGS] ?? []).filter((r) => r.SettingKey === 'ras:perms')).toHaveLength(1);
    expect(await repo.readSharedJson('ras:perms', null)).toEqual({ adminGroupIds: [6] });
  });

  it('壊れた共有 JSON は既定値にフォールバックする', async () => {
    const lists = fakeLists({ [LIST_SETTINGS]: [{ Id: 1, __etag: '"1"', SettingKey: 'ras:perms', Value: '{壊れ' }] });
    expect(await repoOf(lists).readSharedJson('ras:perms', { adminGroupIds: [] })).toEqual({ adminGroupIds: [] });
  });
});

describe('列名の安全性', () => {
  // SharePoint のカスタムリストに最初から入っている列。ここと同じ名前で列を作ろうとすると、
  // 作成は「既にある」で素通りするのに **書き込みだけが必ず失敗する**。
  // ★実際に QamRasTickets.Created で踏んだ（Created は組み込みの DateTime 列）。
  //   実行時ガードはあるが、起動して初めて分かるのでは遅い。ここで落とす。
  const BUILT_IN = [
    'ID', 'Id', 'Title', 'Created', 'Modified', 'Author', 'Editor', 'GUID', 'Order', 'Version',
    'Attachments', 'ContentType', 'ContentTypeId', 'FileLeafRef', 'FileDirRef', 'FileRef',
    'FSObjType', 'Level', 'UniqueId', 'DocIcon', 'ItemChildCount', 'FolderChildCount',
    'AppAuthor', 'AppEditor', 'ComplianceAssetId', '_UIVersionString', '_ModerationStatus',
  ];

  it.each(ALL_LISTS.map((l) => [l.title, l] as const))('%s の列名が組み込み列と衝突しない', (_title, list) => {
    const hits = list.fields.map((f) => f.name).filter((n) => BUILT_IN.includes(n));
    expect(hits).toEqual([]);
  });

  it('列名は空白を含まない ASCII（内部名が _x0020_ 化されて表示名とずれるのを防ぐ）', () => {
    const bad = ALL_LISTS.flatMap((l) => l.fields.map((f) => `${l.title}.${f.name}`).filter((n) => !/^[\w.]+$/.test(n)));
    expect(bad).toEqual([]);
  });

  it('一意制約を張る列は索引付き（SP は Indexed 無しの EnforceUniqueValues を受け付けない）', () => {
    const bad = ALL_LISTS.flatMap((l) => l.fields.filter((f) => f.enforceUnique && !f.indexed).map((f) => `${l.title}.${f.name}`));
    expect(bad).toEqual([]);
  });
});

describe('資産で設定した会社をチケットへ写す', () => {
  const asset = (hostId: string, ip: string) =>
    ({ key: hostId, hostId, settenId: 'R100', ip, fqdn: `${hostId}.example`, status: '',
       trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: '', managementCompany: '' });
  const ticket = (n: string, hostId: string, ip: string) =>
    ({ number: n, state: 'OPEN', hostId, ip, fqdn: 'a', settenId: 'R100', businessCompany: '', managementCompany: '',
       created: '', firstFound: '2026-08-01 00:00:00', lastFound: '' });

  it('資産の会社を変えると、同じホストのチケットにも反映される', async () => {
    // ★写さないと、資産で直しても次の取込までチケット一覧が古いままになり、
    //   事業会社に至ってはアクセス権の判定もずれる。
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.syncRasAssets([asset('h1', '10.0.0.1')]);
    await repo.syncRasTickets([ticket('11', 'h1', '10.0.0.1'), ticket('12', 'h9', '10.9.9.9')]);
    await repo.setRasCompany('h1', 'A事業会社', 'X保守');
    const rows = lists.rows[LIST_RAS_TICKETS];
    expect(rows.find((r) => r.Title === '11')!.BusinessCompany).toBe('A事業会社');
    expect(rows.find((r) => r.Title === '11')!.ManagementCompany).toBe('X保守');
    expect(rows.find((r) => r.Title === '12')!.BusinessCompany).toBe(''); // 別ホストは触らない
  });

  it('CSV の一括取込でも同じように反映される', async () => {
    const lists = fakeLists();
    const repo = repoOf(lists);
    await repo.syncRasAssets([asset('h1', '10.0.0.1'), asset('h2', '10.0.0.2')]);
    await repo.syncRasTickets([ticket('11', 'h1', '10.0.0.1'), ticket('21', 'h2', '10.0.0.2')]);
    await repo.setRasCompaniesBulk([
      { key: 'h1', businessCompany: 'A事業会社', managementCompany: 'X保守' },
      { key: 'h2', businessCompany: 'B事業会社', managementCompany: 'Y保守' },
    ]);
    const rows = lists.rows[LIST_RAS_TICKETS];
    expect(rows.find((r) => r.Title === '11')!.BusinessCompany).toBe('A事業会社');
    expect(rows.find((r) => r.Title === '21')!.ManagementCompany).toBe('Y保守');
  });
});
