import { describe, it, expect } from 'vitest';
import { settenId, fmtJst, historyColumns, assetColumns, ASSET_DEFAULT_HIDDEN, HISTORY_DEFAULT_HIDDEN } from '../src/ui/columns';
import type { QamEvent } from '../src/types';

const noComments2 = { byId: {}, openThread: () => undefined, save: async () => [] } as any;
// 既定で見える列（hidden を除いた順）。
const visibleIds = (cols: { id: string }[], hidden: string[]): string[] => cols.map((c) => c.id).filter((id) => !hidden.includes(id));

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
    // 専用列がある項目(IP)は 変更前/変更後 には出さない
    expect(cellOf(cols, 'old', e)).toBe('');
    expect(cellOf(cols, 'new', e)).toBe('');
    // 専用列が無い項目(OS)は従来どおり 変更前/変更後 に出す
    const os = ev({ entity: 'host', field: 'OS', old: 'Linux', new: 'Windows' });
    expect(cellOf(cols, 'new', os)).toContain('Windows');
  });

  it('domain: NETBLOCK の追加/削除を IP 列に', () => {
    const cols = historyColumns('domain', noComments as any);
    const e = ev({ entity: 'domain', field: 'NETBLOCK', added: ['10.0.1.0-10.0.1.255'], removed: [] });
    expect(cellOf(cols, 'add_ip', e)).toBe('10.0.1.0-10.0.1.255');
  });

  it('CSV取込(props+変更項目)でも追加/削除IP・FQDN列に出る', () => {
    const cols = historyColumns('host', noComments as any);
    // 追加: props の IP/FQDN が「追加」側に出る（field は列キーと一致しないので props 経路）
    const added = ev({ entity: 'host', change: 'added', field: 'IPアドレス・FQDN', props: [{ k: 'IP', v: '10.1.1.1' }, { k: 'FQDN', v: 'h1.example' }] });
    expect(cellOf(cols, 'add_ip', added)).toBe('10.1.1.1');
    expect(cellOf(cols, 'add_fqdn', added)).toBe('h1.example');
    expect(cellOf(cols, 'rem_ip', added)).toBe('');
    // 削除: 同じ props が「削除」側に出る
    const deleted = ev({ entity: 'host', change: 'deleted', field: 'IPアドレス・FQDN', props: [{ k: 'IP', v: '10.1.1.1' }, { k: 'FQDN', v: 'h1.example' }] });
    expect(cellOf(cols, 'rem_ip', deleted)).toBe('10.1.1.1');
    expect(cellOf(cols, 'rem_fqdn', deleted)).toBe('h1.example');
    expect(cellOf(cols, 'add_ip', deleted)).toBe('');
  });

  it('既定の表示列と順番（一覧）', () => {
    expect(visibleIds(assetColumns('group', noComments2), ASSET_DEFAULT_HIDDEN.group))
      .toEqual(['SETTEN', 'name', 'DIVISION', 'FUNCTION', 'LOCATION', 'IPS', 'DNS_LIST', 'COMMENTS', 'LAST_UPDATE', '_c']);
    expect(visibleIds(assetColumns('host', noComments2), ASSET_DEFAULT_HIDDEN.host))
      .toEqual(['AG_SETTEN', 'IP', 'name', 'TRACKING_METHOD', 'LAST_VULN_SCAN_DATETIME', '_c']);
    expect(visibleIds(assetColumns('domain', noComments2), ASSET_DEFAULT_HIDDEN.domain))
      .toEqual(['key', 'AG_SETTEN', 'NETBLOCK', '_c']);
  });

  it('既定の表示列と順番（変更履歴）', () => {
    expect(visibleIds(historyColumns('group', noComments2), HISTORY_DEFAULT_HIDDEN.group))
      .toEqual(['ts', 'setten', 'name', 'change', 'field', 'add_ip', 'add_dns', 'rem_ip', 'rem_dns', 'old', 'new', '_c']);
    expect(visibleIds(historyColumns('host', noComments2), HISTORY_DEFAULT_HIDDEN.host))
      .toEqual(['ts', 'setten', 'change', 'field', 'add_ip', 'add_fqdn', 'rem_ip', 'rem_fqdn', 'old', 'new', '_c']);
    expect(visibleIds(historyColumns('domain', noComments2), HISTORY_DEFAULT_HIDDEN.domain))
      .toEqual(['ts', 'id', 'change', 'field', 'add_ip', 'rem_ip', '_c']);
  });

  it('host履歴の接続点ID: 現所属/削除時の所属AG/ CSV取込 の順で解決', () => {
    const agSetten = { h1: 'XX999' };                 // 現スナップショットの host→接続点ID
    const agIdSetten = { '100': 'AB123', '300': 'CD456' }; // AG ID→接続点ID
    const cols = historyColumns('host', noComments as any, agSetten, agIdSetten);
    // (1) 現所属の host
    expect(cellOf(cols, 'setten', ev({ entity: 'host', id: 'h1' }))).toBe('XX999');
    // (2) 削除済み host は props の ASSET_GROUP_IDS から復元
    expect(cellOf(cols, 'setten', ev({ entity: 'host', id: 'gone', change: 'deleted', props: [{ k: 'ASSET_GROUP_IDS', v: '100, 300' }] }))).toBe('AB123, CD456');
    // (3) CSV取込（id未解決）は props の接続点ID
    expect(cellOf(cols, 'setten', ev({ entity: 'host', id: '', props: [{ k: '接続点ID', v: 'EF789' }] }))).toBe('EF789');
  });

  it('domain/host は名前列を出さない（host は IP列も無し）', () => {
    expect(historyColumns('domain', noComments as any).some((c) => c.id === 'name')).toBe(false);
    const host = historyColumns('host', noComments as any);
    expect(host.some((c) => c.id === 'name')).toBe(false);
    expect(host.some((c) => c.id === 'ip')).toBe(false);
    // group/user は名前列あり
    expect(historyColumns('group', noComments as any).some((c) => c.id === 'name')).toBe(true);
  });
});

describe('メモ列のその場編集（ブランク化）', () => {
  const rec = { key: 'g1', name: 'X', scalar: {}, set: {}, info: {}, hash: '' } as any;
  const cellFor = (api: any) => assetColumns('group', api).find((c) => c.id === '_c')!.render(rec) as HTMLElement;
  const flush = () => new Promise((r) => setTimeout(r));

  it('既存メモを全文消すと空文字で保存され、復活せずブランク表示になる', async () => {
    let store: any[] = [{ ts: '2026-01-01T00:00:00Z', entity: 'group', id: 'g1', author: 'me', text: 'メモA' }];
    const calls: any[] = [];
    const api = {
      byId: { g1: [...store] }, openThread: () => undefined,
      save: async (_e: string, _id: string, ts: string | null, text: string) => {
        calls.push({ ts, text });
        store = ts ? store.map((c) => (c.ts === ts ? { ...c, text } : c)) : [...store, { ts: 'new', entity: 'group', id: 'g1', author: 'me', text }];
        return [...store];
      },
    };
    const cell = cellFor(api);
    expect(cell.querySelector('.qam-comment-view')!.textContent).toBe('メモA');
    (cell.querySelector('.qam-comment-view') as HTMLElement).click(); // → 編集
    const ta = cell.querySelector('textarea.qam-comment-edit') as HTMLTextAreaElement;
    expect(ta.value).toBe('メモA');
    ta.value = ''; ta.dispatchEvent(new Event('blur')); // 全文消去して確定
    await flush();
    expect(calls).toEqual([{ ts: '2026-01-01T00:00:00Z', text: '' }]); // 既存 ts を空文字で更新
    const v = cell.querySelector('.qam-comment-view')!;
    expect(v.classList.contains('is-empty')).toBe(true);
    expect(v.textContent).toBe('＋ メモ'); // 復活しない
  });

  it('メモ未登録のまま空で確定しても新規作成しない', async () => {
    const calls: any[] = [];
    const api = { byId: {}, openThread: () => undefined, save: async (..._a: any[]) => { calls.push(_a); return []; } };
    const cell = cellFor(api);
    (cell.querySelector('.qam-comment-view') as HTMLElement).click();
    const ta = cell.querySelector('textarea.qam-comment-edit') as HTMLTextAreaElement;
    ta.value = '   '; ta.dispatchEvent(new Event('blur'));
    await flush();
    expect(calls).toEqual([]); // 空の新規は保存しない
  });
});
