import { describe, it, expect } from 'vitest';
import {
  isRasSetten, deriveRasAssets, deriveRasTickets, normalizeRasPerms, registeredCompanies,
  groupIdsFor, canApplyPerms, parseCompanyList, mergeCompanies, pickRoles, buildItemPermPlan,
  companiesWithoutGroups, assetsWithoutCompany, type RasAsset,
} from '../src/ras';
import type { QamRecord, QamTicket } from '../src/types';

const host = (key: string, ip: string, fqdn = '', dns = ''): QamRecord =>
  ({ key, name: fqdn || dns || ip, scalar: { IP: ip, FQDN: fqdn, DNS: dns }, set: {}, info: {}, hash: '' });

const ticket = (number: string, hostId: string, ip: string, state = 'OPEN'): QamTicket =>
  ({ number, state, hostId, ip, fqdn: '', created: '2026-08-01T09:30:00Z' });

describe('独自RASの判定', () => {
  it('接続点IDが R で始まるものだけが対象', () => {
    expect(isRasSetten('R1234')).toBe(true);
    expect(isRasSetten('  R99 ')).toBe(true); // 前後の空白は無視
    expect(isRasSetten('AB123')).toBe(false);
    expect(isRasSetten('')).toBe(false);
  });

  it('小文字の r は対象外（接続点IDは大文字運用なので別物として扱う）', () => {
    expect(isRasSetten('r1234')).toBe(false);
  });
});

describe('RAS資産の組み立て', () => {
  const hosts = [host('1', '10.0.0.1', 'a.example'), host('2', '10.0.0.2', '', 'b.example'), host('3', '10.0.0.3', 'c.example')];
  const setten = { '1': 'R100', '2': 'AB200', '3': 'R300,AB400' };

  it('R始まりの接続点に属する資産だけを拾う', () => {
    const rows = deriveRasAssets(hosts, setten, new Map());
    expect(rows.map((r) => r.hostId)).toEqual(['1', '3']);
  });

  it('複数の接続点に属していても R 始まりの分だけを持つ', () => {
    const r = deriveRasAssets(hosts, setten, new Map()).find((x) => x.hostId === '3')!;
    expect(r.settenId).toBe('R300'); // AB400 は載せない
  });

  it('FQDN が無ければ DNS で埋める', () => {
    const rows = deriveRasAssets([hosts[1]], { '2': 'R200' }, new Map());
    expect(rows[0].fqdn).toBe('b.example');
  });

  it('登録済みの事業会社・管理会社は取込で消えない', () => {
    // ★ここが消えると、取込のたびに手入力が飛ぶ。
    const prev = new Map<string, RasAsset>([['1', { hostId: '1', settenId: 'R100', ip: 'x', fqdn: 'x', businessCompany: 'A社', managementCompany: 'B保守' }]]);
    const r = deriveRasAssets(hosts, setten, prev).find((x) => x.hostId === '1')!;
    expect(r.businessCompany).toBe('A社');
    expect(r.managementCompany).toBe('B保守');
    expect(r.ip).toBe('10.0.0.1'); // IP/FQDN は最新のスナップショットで上書き
  });
});

describe('RASチケットの絞り込み', () => {
  const assets: RasAsset[] = [
    { hostId: '1', settenId: 'R100', ip: '10.0.0.1', fqdn: 'a.example', businessCompany: 'A社', managementCompany: '' },
  ];

  it('RAS資産のチケットだけを残し、事業会社を写す', () => {
    const rows = deriveRasTickets([ticket('11', '1', '10.0.0.1'), ticket('12', '9', '10.9.9.9')], assets, {});
    expect(rows.map((r) => r.number)).toEqual(['11']);
    expect(rows[0].businessCompany).toBe('A社');
  });

  it('HOST_ID が無いチケットは IP からホストを引く', () => {
    const rows = deriveRasTickets([ticket('13', '', '10.0.0.1')], assets, { '10.0.0.1': '1' });
    expect(rows.map((r) => r.number)).toEqual(['13']);
    expect(rows[0].hostId).toBe('1');
  });
});

describe('アクセス権の設定', () => {
  it('壊れた保存値でも落とさず既定に整える', () => {
    expect(normalizeRasPerms(null)).toEqual({ adminGroupIds: [], byBusinessCompany: {} });
    expect(normalizeRasPerms({ adminGroupIds: ['3', 0, -1, 3], byBusinessCompany: 'x' }))
      .toEqual({ adminGroupIds: [3], byBusinessCompany: {} });
  });

  it('割当が空でも登録済みの会社は残す', () => {
    // 消すと画面から会社が消えて、登録し直しになる。
    const p = normalizeRasPerms({ byBusinessCompany: { 'A社': [], 'B社': [7] } });
    expect(registeredCompanies(p)).toEqual(['A社', 'B社']);
    expect(groupIdsFor('A社', p)).toEqual([]);
    expect(companiesWithoutGroups(p)).toEqual(['A社']);
  });

  it('管理者グループが無ければ権限を適用しない', () => {
    // 継承だけ解除して誰も更新できないアイテムを作らないための歯止め。
    expect(canApplyPerms(normalizeRasPerms({ byBusinessCompany: { 'A社': [7] } }))).toBe(false);
    expect(canApplyPerms(normalizeRasPerms({ adminGroupIds: [1] }))).toBe(true);
  });

  it('一括入力はタブ区切りの先頭列を使い、空行と重複を落とす', () => {
    expect(parseCompanyList('A社\t備考\nB社\n\nA社\n  C社  ')).toEqual(['A社', 'B社', 'C社']);
  });

  it('再登録しても既存の割当は消えない', () => {
    const p = normalizeRasPerms({ adminGroupIds: [1], byBusinessCompany: { 'A社': [7], 'B社': [8] } });
    const next = mergeCompanies(p, ['A社', 'C社']);
    expect(next.byBusinessCompany).toEqual({ 'A社': [7], 'C社': [] }); // B社は登録から外れる
    expect(next.adminGroupIds).toEqual([1]);
  });
});

describe('付与内容の組み立て', () => {
  const roles = pickRoles([{ Id: 1073741826, RoleTypeKind: 2 }, { Id: 1073741829, RoleTypeKind: 5 }]);
  const p = normalizeRasPerms({ adminGroupIds: [5], byBusinessCompany: { 'A社': [7, 5], 'B社': [] } });

  it('読み取りとフルコントロールのロールIDを選ぶ', () => {
    expect(roles).toEqual({ read: 1073741826, full: 1073741829 });
  });

  it('ロール定義が足りなければ失敗させる', () => {
    expect(() => pickRoles([{ Id: 1, RoleTypeKind: 2 }])).toThrow(/ロール定義/);
  });

  it('管理者はフルコントロール、事業会社は読み取り', () => {
    const [plan] = buildItemPermPlan([{ id: 10, businessCompany: 'A社' }], p);
    expect(plan.full).toEqual([5]);
    // ★管理者と同じグループには読み取りを重ねない。SPは後勝ちにならず権限が下がる。
    expect(plan.read).toEqual([7]);
  });

  it('割当の無い会社・未設定の資産は管理者だけが持つ', () => {
    const plans = buildItemPermPlan([{ id: 1, businessCompany: 'B社' }, { id: 2, businessCompany: '' }], p);
    expect(plans.map((x) => x.read)).toEqual([[], []]);
    expect(plans.every((x) => x.full.length === 1)).toBe(true);
  });

  it('事業会社が未設定のRAS資産を数えられる', () => {
    const assets: RasAsset[] = [
      { hostId: '1', settenId: 'R1', ip: '', fqdn: '', businessCompany: 'A社', managementCompany: '' },
      { hostId: '2', settenId: 'R2', ip: '', fqdn: '', businessCompany: '  ', managementCompany: '' },
    ];
    expect(assetsWithoutCompany(assets).map((a) => a.hostId)).toEqual(['2']);
  });
});
