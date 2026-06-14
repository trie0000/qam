import { describe, it, expect, beforeEach } from 'vitest';
import { parseQualysXml } from '../src/ingest/parse';
import {
  FileBackend, getSnapshotStamps, resolveAsof, ingestSnapshot, deleteSnapshot,
  prune, addComment, editComment, readComments, readHistory, readAnnotations, setAnnotation, removeHistoryEvents, logOp, readOps, importHistory,
} from '../src/store';
import type { QamEvent } from '../src/types';

class MemBackend implements FileBackend {
  files = new Map<string, string>();
  async read(p: string) { return this.files.has(p) ? this.files.get(p)! : null; }
  async write(p: string, c: string, append?: boolean) {
    this.files.set(p, append && this.files.has(p) ? this.files.get(p)! + c : c);
  }
  async list(dir: string) {
    const pre = dir.endsWith('/') ? dir : dir + '/';
    const out = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]);
    return [...out];
  }
  async remove(p: string) {
    this.files.delete(p);
    const pre = p + '/';
    for (const k of [...this.files.keys()]) if (k.startsWith(pre)) this.files.delete(k);
  }
}

const GROUP1 = `<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST>
<ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>1</OWNER_ID><IP_SET><IP>10.0.0.1</IP></IP_SET></ASSET_GROUP>
<ASSET_GROUP><ID>200</ID><TITLE><![CDATA[Stage]]></TITLE><OWNER_ID>1</OWNER_ID></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;
const GROUP2 = `<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST>
<ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>2</OWNER_ID><IP_SET><IP>10.0.0.1</IP><IP>10.0.0.9</IP></IP_SET></ASSET_GROUP>
<ASSET_GROUP><ID>300</ID><TITLE><![CDATA[New]]></TITLE><OWNER_ID>1</OWNER_ID></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;
const GROUP_EMPTY = `<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST></ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;

const OPTS = { guardRatio: 0.5, retentionDays: 90 };
const S1 = '2026-06-12T08-00-00';
const S2 = '2026-06-12T12-00-00'; // 同じ日の 2 回目
const S3 = '2026-06-13T08-00-00';

describe('store ingest (取込日時 stamp ごと)', () => {
  let b: MemBackend;
  beforeEach(() => { b = new MemBackend(); });

  it('初回は baseline・履歴なし', async () => {
    const r = await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    expect(r.baseline).toBe(true);
    expect(r.committed).toBe(true);
    expect(r.added).toBe(0);
    expect(r.stamp).toBe(S1);
  });

  it('同じ日に2回取り込んでも別ポイントとして残り、2回目は1回目との差分', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    const r = await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 });
    expect(r.added).toBe(1);    // 300
    expect(r.deleted).toBe(1);  // 200
    expect(r.modified).toBe(2); // OWNER_ID / IPS
    const stamps = await getSnapshotStamps(b, 'group');
    expect(stamps).toEqual([S1, S2]);            // 同日でも 2 ポイント
    expect((await readHistory(b, 'group')).length).toBe(4);
  });

  it('asof は stamp で解決（指定時刻以前の最新取込）', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 });
    const stamps = await getSnapshotStamps(b, 'group');
    expect(resolveAsof(stamps)).toBe(S2);                          // 最新
    expect(resolveAsof(stamps, '2026-06-12T10-00-00')).toBe(S1);   // 朝→昼の間 → 朝
    expect(resolveAsof(stamps, S1)).toBe(S1);
    expect(resolveAsof(stamps, '2026-06-12T07-00-00')).toBe(null); // どれより前
  });

  it('件数急減ガード → force で確定', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 });
    const g = await ingestSnapshot(b, parseQualysXml(GROUP_EMPTY), { ...OPTS, stamp: S3 });
    expect(g.guard).toBe(true);
    expect(g.committed).toBe(false);
    const f = await ingestSnapshot(b, parseQualysXml(GROUP_EMPTY), { ...OPTS, stamp: S3, force: true });
    expect(f.committed).toBe(true);
    expect(f.deleted).toBe(2);
  });

  it('prune は古い snapshot を消し history は残す', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 });
    await b.write('snapshots/group/2026-01-01T00-00-00.json', '{}');
    const removed = await prune(b, 30, '2026-06-12');
    expect(removed).toContain('group/2026-01-01T00-00-00');
    expect(removed).not.toContain(`group/${S1}`);
    expect(await b.read('history/group.jsonl')).not.toBeNull();
  });

  it('同じ stamp の再取込は上書き（履歴も置換・点は増えない）', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 }); // S2 に 4 件
    expect((await readHistory(b, 'group')).length).toBe(4);
    // S2 を GROUP1 相当で上書き → prev(S1=GROUP1) と同一で差分0、S2 の旧履歴は置換
    const r = await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S2 });
    expect(r.added + r.modified + r.deleted).toBe(0);
    expect(await getSnapshotStamps(b, 'group')).toEqual([S1, S2]); // 点は増えない
    expect((await readHistory(b, 'group')).length).toBe(0);        // S2 の旧4件は消える
  });

  it('deleteSnapshot は当該取込の snapshot/履歴のみ削除（他は残る）', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 });
    await deleteSnapshot(b, 'group', S2);
    expect(await getSnapshotStamps(b, 'group')).toEqual([S1]);
    expect((await readHistory(b, 'group')).length).toBe(0); // S2 の 4 件削除
  });

  it('removeHistoryEvents は指定 eid の履歴のみ削除', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS, stamp: S1 });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, stamp: S2 });
    const before = await readHistory(b, 'group');
    expect(before.length).toBeGreaterThan(1);
    const n = await removeHistoryEvents(b, 'group', [before[0].eid]);
    expect(n).toBe(1);
    const after = await readHistory(b, 'group');
    expect(after.length).toBe(before.length - 1);
    expect(after.find((e) => e.eid === before[0].eid)).toBeUndefined();
  });

  it('コメントは資産単位', async () => {
    await addComment(b, { ts: '2026-06-13T09:00:00Z', entity: 'host', id: '1', author: 't', text: '対応済み' });
    const c = await readComments(b, 'host', '1');
    expect(c.length).toBe(1);
    expect(c[0].text).toBe('対応済み');
  });

  it('操作履歴(ops)を追記・取得', async () => {
    await logOp(b, { ts: '2026-06-14T09:00:00Z', author: '山田', action: '取込', entity: 'group', detail: '100件' });
    await logOp(b, { ts: '2026-06-14T10:00:00Z', author: '佐藤', action: 'スナップショット削除', entity: 'host', detail: 's1' });
    const ops = await readOps(b);
    expect(ops.length).toBe(2);
    expect(ops[0].author).toBe('山田');
    expect(ops[1].action).toBe('スナップショット削除');
  });

  it('手入力メタ(annotations)を保存・取得・削除（空で消える）', async () => {
    await setAnnotation(b, 'group', '634851', 'FUNCTION', 'ルータ');
    await setAnnotation(b, 'group', '634851', 'LOCATION', '本社');
    let map = await readAnnotations(b, 'group');
    expect(map['634851'].FUNCTION).toBe('ルータ');
    expect(map['634851'].LOCATION).toBe('本社');
    await setAnnotation(b, 'group', '634851', 'FUNCTION', ''); // 空＝削除
    map = await readAnnotations(b, 'group');
    expect(map['634851'].FUNCTION).toBeUndefined();
    expect(map['634851'].LOCATION).toBe('本社');
  });

  it('editComment は ts で同定して本文だけ差し替える', async () => {
    await addComment(b, { ts: '2026-06-13T09:00:00Z', entity: 'host', id: '1', author: 't', text: '初稿' });
    await addComment(b, { ts: '2026-06-13T10:00:00Z', entity: 'host', id: '1', author: 't', text: '二稿' });
    await editComment(b, 'host', '1', '2026-06-13T10:00:00Z', '二稿(修正)');
    const c = await readComments(b, 'host', '1');
    expect(c.map((x) => x.text)).toEqual(['初稿', '二稿(修正)']);
    expect(c[1].author).toBe('t'); // 本文以外は保持
  });

  it('importHistory は重複を除いて追記し、onProgress で done/total を通知する', async () => {
    const mk = (n: number): QamEvent[] => Array.from({ length: n }, (_, i) => ({ eid: `host:${i}:2026-06-13:_`, ts: '2026-06-13', entity: 'host', id: String(i), name: `h${i}`, change: 'added' }));
    const events = mk(2500); // バッチ(1000)を跨ぐ件数
    const prog: [number, number][] = [];
    const n = await importHistory(b, 'host', events, (done, total) => prog.push([done, total]));
    expect(n).toBe(2500);
    expect(prog[prog.length - 1]).toEqual([2500, 2500]); // 最終通知は全件完了
    expect(prog.every(([, total]) => total === 2500)).toBe(true);
    // 同じ events を再取込 → 全件重複でスキップ（追記0・進捗通知なし）
    const prog2: [number, number][] = [];
    const n2 = await importHistory(b, 'host', events, (d, t) => prog2.push([d, t]));
    expect(n2).toBe(0);
    expect(prog2).toEqual([]);
    expect((await readHistory(b, 'host')).length).toBe(2500);
  });
});
