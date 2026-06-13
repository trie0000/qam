import { describe, it, expect, beforeEach } from 'vitest';
import { parseQualysXml } from '../src/ingest/parse';
import {
  FileBackend, getSnapshotDates, resolveAsof, ingestSnapshot,
  prune, addComment, readComments, readHistory,
} from '../src/store';

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

const GROUP1 = `<ASSET_GROUP_LIST_OUTPUT><RESPONSE><DATETIME>2026-06-12T00:00:00Z</DATETIME><ASSET_GROUP_LIST>
<ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>1</OWNER_ID><IP_SET><IP>10.0.0.1</IP></IP_SET></ASSET_GROUP>
<ASSET_GROUP><ID>200</ID><TITLE><![CDATA[Stage]]></TITLE><OWNER_ID>1</OWNER_ID></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;
const GROUP2 = `<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST>
<ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>2</OWNER_ID><IP_SET><IP>10.0.0.1</IP><IP>10.0.0.9</IP></IP_SET></ASSET_GROUP>
<ASSET_GROUP><ID>300</ID><TITLE><![CDATA[New]]></TITLE><OWNER_ID>1</OWNER_ID></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;
const GROUP_EMPTY = `<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST></ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;

const OPTS = { today: '2026-06-14', guardRatio: 0.5, retentionDays: 90 };

describe('store ingest', () => {
  let b: MemBackend;
  beforeEach(() => { b = new MemBackend(); });

  it('baseline は履歴を出さず現状確立', async () => {
    const r = await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS });
    expect(r.baseline).toBe(true);
    expect(r.committed).toBe(true);
    expect(r.added).toBe(0);
    expect(r.date).toBe('2026-06-12');
  });

  it('2日目で added/modified/deleted', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS });
    const r = await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, date: '2026-06-13' });
    expect(r.added).toBe(1);
    expect(r.deleted).toBe(1);
    expect(r.modified).toBe(2); // OWNER_ID / IPS
    expect((await readHistory(b, 'group')).length).toBe(4);
  });

  it('asof 解決', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, date: '2026-06-13' });
    const dates = await getSnapshotDates(b, 'group');
    expect(resolveAsof(dates)).toBe('2026-06-13');
    expect(resolveAsof(dates, '2026-06-12')).toBe('2026-06-12');
    expect(resolveAsof(dates, '2026-06-20')).toBe('2026-06-13');
    expect(resolveAsof(dates, '2026-06-01')).toBe(null);
  });

  it('件数急減ガード → force で確定', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, date: '2026-06-13' });
    const g = await ingestSnapshot(b, parseQualysXml(GROUP_EMPTY), { ...OPTS, date: '2026-06-14' });
    expect(g.guard).toBe(true);
    expect(g.committed).toBe(false);
    const f = await ingestSnapshot(b, parseQualysXml(GROUP_EMPTY), { ...OPTS, date: '2026-06-14', force: true });
    expect(f.committed).toBe(true);
    expect(f.deleted).toBe(2);
  });

  it('prune は古い snapshot を消し history は残す', async () => {
    await ingestSnapshot(b, parseQualysXml(GROUP1), { ...OPTS });
    await ingestSnapshot(b, parseQualysXml(GROUP2), { ...OPTS, date: '2026-06-13' });
    await b.write('snapshots/group/2026-01-01.json', '{}');
    const removed = await prune(b, 30, '2026-06-14');
    expect(removed).toContain('group/2026-01-01');
    expect(removed).not.toContain('group/2026-06-13');
    expect(await b.read('history/group.jsonl')).not.toBeNull();
  });

  it('コメントは資産単位', async () => {
    await addComment(b, { ts: '2026-06-13T09:00:00Z', entity: 'host', id: '1', author: 't', text: '対応済み' });
    await addComment(b, { ts: '2026-06-13T09:01:00Z', entity: 'host', id: '3', author: 't', text: '別件' });
    const c = await readComments(b, 'host', '1');
    expect(c.length).toBe(1);
    expect(c[0].text).toBe('対応済み');
  });
});
