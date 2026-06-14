import { describe, it, expect } from 'vitest';
import { settenId, fmtJst, historyColumns } from '../src/ui/columns';
import type { QamEvent } from '../src/types';

const noComments = { byId: {}, openThread: () => undefined, save: async () => [] };
const cellOf = (cols: ReturnType<typeof historyColumns>, id: string, e: QamEvent): string => {
  const c = cols.find((x) => x.id === id)!;
  const v = c.render(e);
  return typeof v === 'string' ? v : (v.textContent ?? '');
};

describe('settenId（接続点ID 切り出し）', () => {
  it('タイトル先頭〜最初の半角スペースを切り出す（形式ルールなし）', () => {
    expect(settenId('AB123 東京拠点ルータ')).toBe('AB123');
    expect(settenId('CD1234D 大阪')).toBe('CD1234D');
    expect(settenId('A123 単一英字でもそのまま')).toBe('A123');
    expect(settenId('ABCD 数字なしでもそのまま')).toBe('ABCD');
    expect(settenId('AB123-1 余分な文字も先頭トークンとして採用')).toBe('AB123-1');
  });
  it('半角スペースが無ければ全体、空は空', () => {
    expect(settenId('AB123')).toBe('AB123');
    expect(settenId('接続点なし')).toBe('接続点なし');
    expect(settenId('')).toBe('');
  });
});

describe('fmtJst（ISO UTC → JST 表示）', () => {
  it('UTC を +9h して JST 表記にする（端末TZ非依存）', () => {
    expect(fmtJst('2024-06-13T08:30:00Z')).toBe('2024-06-13 17:30:00 JST');
    expect(fmtJst('2024-12-31T15:00:00Z')).toBe('2025-01-01 00:00:00 JST'); // 日跨ぎ
    expect(fmtJst('2024-06-13T23:59:59Z')).toBe('2024-06-14 08:59:59 JST');
  });
  it('空/パース不能はそのまま', () => {
    expect(fmtJst('')).toBe('');
    expect(fmtJst('N/A')).toBe('N/A');
  });
});

describe('historyColumns 追加/削除 値列', () => {
  const ev = (p: Partial<QamEvent>): QamEvent => ({ eid: 'x', ts: '2026-06-01', entity: 'group', id: '1', name: 'n', change: 'modified', ...p });

  it('group: IPS/DNS の追加・削除を各列に振り分ける', () => {
    const cols = historyColumns('group', noComments as any);
    const ips = ev({ field: 'IPS', added: ['10.0.0.9'], removed: ['10.0.0.1'] });
    expect(cellOf(cols, 'add_ip', ips)).toBe('10.0.0.9');
    expect(cellOf(cols, 'rem_ip', ips)).toBe('10.0.0.1');
    expect(cellOf(cols, 'add_dns', ips)).toBe(''); // IPS行はDNS列空
    const dns = ev({ field: 'DNS_LIST', added: ['b.example'], removed: [] });
    expect(cellOf(cols, 'add_dns', dns)).toBe('b.example');
    expect(cellOf(cols, 'add_ip', dns)).toBe('');
  });

  it('group: 追加/削除イベントは props から全値を出す', () => {
    const cols = historyColumns('group', noComments as any);
    const added = ev({ change: 'added', props: [{ k: 'IPS', v: '10.0.0.1, 10.0.0.2' }, { k: 'DNS_LIST', v: 'a.example' }] });
    expect(cellOf(cols, 'add_ip', added)).toBe('10.0.0.1, 10.0.0.2');
    expect(cellOf(cols, 'rem_ip', added)).toBe(''); // 追加イベントに削除側は無し
    const deleted = ev({ change: 'deleted', props: [{ k: 'IPS', v: '10.9.9.9' }] });
    expect(cellOf(cols, 'rem_ip', deleted)).toBe('10.9.9.9');
    expect(cellOf(cols, 'add_ip', deleted)).toBe('');
  });

  it('host: scalar IP/FQDN は new/old を追加/削除列に', () => {
    const cols = historyColumns('host', noComments as any);
    const e = ev({ entity: 'host', field: 'IP', old: '10.0.0.1', new: '10.0.0.5' });
    expect(cellOf(cols, 'add_ip', e)).toBe('10.0.0.5');
    expect(cellOf(cols, 'rem_ip', e)).toBe('10.0.0.1');
  });

  it('domain: NETBLOCK の追加/削除を IP 列に', () => {
    const cols = historyColumns('domain', noComments as any);
    const e = ev({ entity: 'domain', field: 'NETBLOCK', added: ['10.0.1.0-10.0.1.255'], removed: [] });
    expect(cellOf(cols, 'add_ip', e)).toBe('10.0.1.0-10.0.1.255');
  });
});
