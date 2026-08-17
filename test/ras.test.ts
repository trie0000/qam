import { describe, it, expect } from 'vitest';
import {
  isRasSetten, deriveRasAssets, deriveRasTickets, normalizeRasPerms, registeredCompanies,
  groupIdsFor, canApplyPerms, parseCompanyList, mergeCompanies, pickRoles, buildItemPermPlan,
  companiesWithoutGroups, assetsWithoutCompany, expandAgIps, rasKeyForIp, rasKeyForDns, RAS_NOT_ALIVE, RAS_NOT_SCANNED,
  classifyVuln, VULN_CSIRT, VULN_OS_MW,
  aliasesFor, parseAliases, buildAliasIndex, planRasCsvImport, contactNameFor, greetingFor,
  type RasAsset,
} from '../src/ras';
import type { QamRecord, QamTicket } from '../src/types';

const host = (key: string, ip: string, fqdn = '', dns = ''): QamRecord =>
  ({ key, name: fqdn || dns || ip, scalar: { IP: ip, FQDN: fqdn, DNS: dns }, set: {}, info: {}, hash: '' });

const ticket = (number: string, hostId: string, ip: string, state = 'OPEN'): QamTicket =>
  ({ number, state, hostId, ip, fqdn: '', created: '2026-08-01T09:30:00Z', firstFound: '', lastFound: '' });

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

const group = (id: string, title: string, ips: string[], lastUpdate: string, dns: string[] = []): QamRecord =>
  ({ key: id, name: title, scalar: { TITLE: title }, set: { IPS: ips, DNS_LIST: dns }, info: { LAST_UPDATE: lastUpdate }, hash: '' });

const BASE = '2026-08-16'; // 取込日（基準日）

describe('RAS資産の組み立て', () => {
  const hosts = [host('1', '10.0.0.1', 'a.example'), host('2', '10.0.0.2', '', 'b.example'), host('3', '10.0.0.3', 'c.example')];
  const setten = { '1': 'R100', '2': 'AB200', '3': 'R300,AB400' };
  const derive = (h = hosts, g: QamRecord[] = [], reg = new Map<string, RasAsset>(), base = BASE, limit?: number) =>
    deriveRasAssets(h, g, setten, reg, base, limit);

  it('R始まりの接続点に属する資産だけを拾う', () => {
    expect(derive().assets.map((r) => r.hostId)).toEqual(['1', '3']);
  });

  it('複数の接続点に属していても R 始まりの分だけを持つ', () => {
    expect(derive().assets.find((x) => x.hostId === '3')!.settenId).toBe('R300'); // AB400 は載せない
  });

  it('FQDN が無ければ DNS で埋める', () => {
    expect(deriveRasAssets([hosts[1]], [], { '2': 'R200' }, new Map(), BASE).assets[0].fqdn).toBe('b.example');
  });

  it('host list にある資産のステータスは空', () => {
    expect(derive().assets.every((a) => a.status === '')).toBe(true);
  });

  it('登録済みの事業会社・管理会社は取込で消えない', () => {
    // ★ここが消えると、取込のたびに手入力が飛ぶ。
    const prev = new Map<string, RasAsset>([['1', { key: '1', hostId: '1', settenId: 'R100', ip: 'x', fqdn: 'x', status: '', trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: 'A社', managementCompany: 'B保守' }]]);
    const r = derive(hosts, [], prev).assets.find((x) => x.hostId === '1')!;
    expect(r.businessCompany).toBe('A社');
    expect(r.managementCompany).toBe('B保守');
    expect(r.ip).toBe('10.0.0.1'); // IP/FQDN は最新のスナップショットで上書き
  });
});

describe('host not alive の拾い上げ', () => {
  const hosts = [host('1', '10.0.0.1', 'a.example')];
  const setten = { '1': 'R100' };
  const derive = (g: QamRecord[], base = BASE, reg = new Map<string, RasAsset>(), limit?: number) =>
    deriveRasAssets(hosts, g, setten, reg, base, limit);

  it('AssetGroup にあって host list に無い IP を host not alive として足す', () => {
    // ★host list だけを見ると、応答が無いホストが一覧から丸ごと抜ける。
    const g = [group('g1', 'R100 拠点', ['10.0.0.1', '10.0.0.5'], '2026-08-10T00:00:00Z')];
    const rows = derive(g).assets;
    expect(rows.map((r) => `${r.ip}:${r.status}`)).toEqual(['10.0.0.1:', `10.0.0.5:${RAS_NOT_ALIVE}`]);
    expect(rows.find((r) => r.ip === '10.0.0.5')!.key).toBe(rasKeyForIp('10.0.0.5'));
    expect(rows.find((r) => r.ip === '10.0.0.5')!.hostId).toBe(''); // ホストIDは無い
  });

  it('AssetGroup の最終更新が基準日と同じなら Scan未実施 として出す', () => {
    // ★not alive と同じ扱いにすると「応答が無い」と誤解される。区別して一覧には出す。
    const g = [group('g1', 'R100 拠点', ['10.0.0.1', '10.0.0.5'], `${BASE}T09:00:00Z`)];
    const r = derive(g);
    expect(r.assets.map((x) => `${x.ip}:${x.status}`)).toEqual(['10.0.0.1:', `10.0.0.5:${RAS_NOT_SCANNED}`]);
    expect(r.pendingSetten).toEqual(['R100']);
  });

  it('R始まりでない接続点の AssetGroup は見ない', () => {
    const g = [group('g2', 'AB200 別拠点', ['10.9.9.9'], '2026-08-10T00:00:00Z')];
    expect(derive(g).assets.map((x) => x.ip)).toEqual(['10.0.0.1']);
  });

  it('同じ IP が複数のRAS接続点に登録されていれば接続点IDをまとめる', () => {
    const g = [
      group('g1', 'R100 拠点', ['10.0.0.5'], '2026-08-10T00:00:00Z'),
      group('g2', 'R200 拠点', ['10.0.0.5'], '2026-08-10T00:00:00Z'),
    ];
    const row = derive(g).assets.find((x) => x.ip === '10.0.0.5')!;
    expect(row.settenId).toBe('R100,R200');
  });

  it('AssetGroup に DNS_LIST でだけ登録された資産も拾う', () => {
    // ★IP_SET だけを見ると、名前で登録した資産だけが一覧に出ない（実際に踏んだ）。
    const g = [group('g1', 'R100 拠点', [], '2026-08-10T00:00:00Z', ['ras1.example', 'ras2.example'])];
    const rows = derive(g).assets;
    // IP を持つ行が先、DNS名だけの行は後ろ。
    expect(rows.map((r) => `${r.fqdn}:${r.status}`)).toEqual([
      'a.example:', `ras1.example:${RAS_NOT_ALIVE}`, `ras2.example:${RAS_NOT_ALIVE}`,
    ]);
    expect(rows.find((r) => r.fqdn === 'ras1.example')!.key).toBe(rasKeyForDns('ras1.example'));
    expect(rows.find((r) => r.fqdn === 'ras1.example')!.ip).toBe(''); // IP は分からない
  });

  it('host list に同じ名前があれば DNS_LIST 側は重複させない（大文字小文字は無視）', () => {
    const g = [group('g1', 'R100 拠点', [], '2026-08-10T00:00:00Z', ['A.EXAMPLE'])];
    expect(derive(g).assets).toHaveLength(1); // host list の a.example だけ
  });

  it('DNS_LIST も最終更新が基準日なら Scan未実施', () => {
    const g = [group('g1', 'R100 拠点', [], `${BASE}T09:00:00Z`, ['ras1.example'])];
    expect(derive(g).assets.find((r) => r.fqdn === 'ras1.example')!.status).toBe(RAS_NOT_SCANNED);
  });

  it('同じ名前が複数のRAS接続点にあれば接続点IDをまとめる', () => {
    const g = [
      group('g1', 'R100 拠点', [], '2026-08-10T00:00:00Z', ['ras1.example']),
      group('g2', 'R200 拠点', [], '2026-08-10T00:00:00Z', ['ras1.example']),
    ];
    expect(derive(g).assets.find((r) => r.fqdn === 'ras1.example')!.settenId).toBe('R100,R200');
  });

  it('IPは数値順に並べる（10.0.0.10 が 10.0.0.2 より前に来ないこと）', () => {
    const g = [group('g1', 'R100 拠点', ['10.0.0.2', '10.0.0.10'], '2026-08-10T00:00:00Z')];
    expect(derive(g).assets.map((r) => r.ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.10']);
  });

  it('IPレンジは展開し、上限を超えた分は件数で返す（黙って捨てない）', () => {
    const g = [group('g1', 'R100 拠点', ['10.0.0.10-10.0.0.19'], '2026-08-10T00:00:00Z')];
    const all = derive(g);
    expect(all.assets.filter((x) => x.status === RAS_NOT_ALIVE)).toHaveLength(10);
    const capped = derive(g, BASE, new Map(), 3);
    expect(capped.assets.filter((x) => x.status === RAS_NOT_ALIVE)).toHaveLength(3);
    expect(capped.droppedIps).toBe(7);
  });

  it('not alive の資産にも事業会社を登録でき、取込で消えない', () => {
    const g = [group('g1', 'R100 拠点', ['10.0.0.5'], '2026-08-10T00:00:00Z')];
    const prev = new Map<string, RasAsset>([[rasKeyForIp('10.0.0.5'),
      { key: rasKeyForIp('10.0.0.5'), hostId: '', settenId: 'R100', ip: '10.0.0.5', fqdn: '', status: RAS_NOT_ALIVE, trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: 'A社', managementCompany: '' }]]);
    expect(derive(g, BASE, prev).assets.find((x) => x.ip === '10.0.0.5')!.businessCompany).toBe('A社');
  });
});

describe('AssetGroup の IP 表記の展開', () => {
  it('単体とレンジを個々の IP にする', () => {
    expect(expandAgIps(['10.0.0.1', '10.0.0.4-10.0.0.6'], 100).ips).toEqual(['10.0.0.1', '10.0.0.4', '10.0.0.5', '10.0.0.6']);
  });

  it('壊れた表記はそのまま1件として残す（黙って消さない）', () => {
    expect(expandAgIps(['not-an-ip'], 100).ips).toEqual(['not-an-ip']);
  });

  it('上限に達したら残数を返す', () => {
    const r = expandAgIps(['10.0.0.1-10.0.0.100'], 10);
    expect(r.ips).toHaveLength(10);
    expect(r.dropped).toBe(90);
  });
});

describe('RASチケットの絞り込み', () => {
  const assets: RasAsset[] = [
    { key: '1', hostId: '1', settenId: 'R100', ip: '10.0.0.1', fqdn: 'a.example', status: '', trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: 'A社', managementCompany: '' },
    // host not alive の行（hostId が空）。ここにチケットが誤って当たらないことも確かめる。
    { key: rasKeyForIp('10.0.0.5'), hostId: '', settenId: 'R100', ip: '10.0.0.5', fqdn: '', status: RAS_NOT_ALIVE, trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: 'A社', managementCompany: '' },
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
    expect(normalizeRasPerms(null)).toEqual({ adminGroupIds: [], byBusinessCompany: {}, aliasesByCompany: {}, contactNameByCompany: {} });
    expect(normalizeRasPerms({ adminGroupIds: ['3', 0, -1, 3], byBusinessCompany: 'x' }))
      .toEqual({ adminGroupIds: [3], byBusinessCompany: {}, aliasesByCompany: {}, contactNameByCompany: {} });
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
      { key: '1', hostId: '1', settenId: 'R1', ip: '', fqdn: '', status: '', trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: 'A社', managementCompany: '' },
      { key: '2', hostId: '2', settenId: 'R2', ip: '', fqdn: '', status: '', trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: '  ', managementCompany: '' },
    ];
    expect(assetsWithoutCompany(assets).map((a) => a.hostId)).toEqual(['2']);
  });
});

describe('略称マスター', () => {
  it('登録済みの会社にひもづく略称だけを持つ（会社を消したら略称も消える）', () => {
    const p = normalizeRasPerms({
      byBusinessCompany: { 'A事業会社': [] },
      aliasesByCompany: { 'A事業会社': ['A社', 'ＡＡ'], '消えた会社': ['X'] },
    });
    expect(aliasesFor('A事業会社', p)).toEqual(['A社', 'ＡＡ']);
    expect(aliasesFor('消えた会社', p)).toEqual([]);
  });

  it('入力欄はカンマ・読点・改行で区切る', () => {
    expect(parseAliases('A社, B社、C社\nA社')).toEqual(['A社', 'B社', 'C社']);
  });

  it('略称と正式名の両方から引ける（大文字小文字は無視）', () => {
    const p = normalizeRasPerms({ byBusinessCompany: { 'A事業会社': [] }, aliasesByCompany: { 'A事業会社': ['ACo'] } });
    const idx = buildAliasIndex(p);
    expect(idx.get('aco')).toBe('A事業会社');
    expect(idx.get('a事業会社')).toBe('A事業会社');
  });

  it('会社を再登録しても略称は消えない', () => {
    const p = normalizeRasPerms({ byBusinessCompany: { 'A事業会社': [7] }, aliasesByCompany: { 'A事業会社': ['A社'] } });
    expect(mergeCompanies(p, ['A事業会社', 'B事業会社']).aliasesByCompany).toEqual({ 'A事業会社': ['A社'] });
  });
});

describe('管理CSV の取込', () => {
  const assets: RasAsset[] = [
    { key: '1', hostId: '1', settenId: 'R100', ip: '10.0.0.1', fqdn: 'a.example', status: '', trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: '', managementCompany: '' },
    { key: rasKeyForIp('10.0.0.5'), hostId: '', settenId: 'R100', ip: '10.0.0.5', fqdn: '', status: RAS_NOT_ALIVE, trackingMethod: '', registeredAt: '', lastScan: '', note: '', businessCompany: '', managementCompany: '' },
  ];
  const perms = normalizeRasPerms({
    byBusinessCompany: { 'A事業会社': [7], 'B事業会社': [] },
    aliasesByCompany: { 'A事業会社': ['A社'], 'B事業会社': ['B'] },
  });
  const csv = (rows: string[][]) => planRasCsvImport(rows, assets, perms);

  it('IPで突き合わせ、略称を正式名に直して埋める', () => {
    const r = csv([['IPアドレス', '事業会社', '管理会社'], ['10.0.0.1', 'A社', 'X保守']]);
    expect(r.updates).toEqual([{ key: '1', businessCompany: 'A事業会社', managementCompany: 'X保守' }]);
    expect(r.usedHeaders).toEqual({ ip: 'IPアドレス', company: '事業会社', management: '管理会社' });
  });

  it('host not alive の資産にも当たる（IPしか無くても引ける）', () => {
    const r = csv([['IP', '事業会社'], ['10.0.0.5', 'B']]);
    expect(r.updates).toEqual([{ key: rasKeyForIp('10.0.0.5'), businessCompany: 'B事業会社', managementCompany: '' }]);
  });

  it('IP列が無ければ FQDN で突き合わせる', () => {
    const r = csv([['FQDN', '事業会社'], ['A.EXAMPLE', 'A社']]);
    expect(r.updates.map((u) => u.key)).toEqual(['1']); // 大文字小文字は無視
  });

  it('引き当てられない略称では上書きせず、名前を挙げる', () => {
    // ★勝手に未登録の会社名を入れると、割当が無い＝管理者しか見られない行が静かに増える。
    const r = csv([['IP', '事業会社', '管理会社'], ['10.0.0.1', '謎商事', 'X保守']]);
    expect(r.unresolvedAliases).toEqual(['謎商事']);
    expect(r.updates).toEqual([{ key: '1', businessCompany: '', managementCompany: 'X保守' }]); // 管理会社だけ入る
  });

  it('一覧に無い行は件数で返す（黙って捨てない）', () => {
    const r = csv([['IP', '事業会社'], ['10.9.9.9', 'A社']]);
    expect(r.unmatchedRows).toBe(1);
    expect(r.updates).toEqual([]);
  });

  it('実運用のヘッダ（事業会社 / 管理会社 / IP / FQDN）をそのまま読める', () => {
    const r = csv([
      ['事業会社', '管理会社', 'IP', 'FQDN'],
      ['A社', 'X保守', '10.0.0.1', 'a.example'],
      ['B', 'Y保守', '10.0.0.5', ''],
    ]);
    expect(r.usedHeaders).toEqual({ company: '事業会社', management: '管理会社', ip: 'IP', fqdn: 'FQDN' });
    expect(r.updates).toEqual([
      { key: '1', businessCompany: 'A事業会社', managementCompany: 'X保守' },
      { key: rasKeyForIp('10.0.0.5'), businessCompany: 'B事業会社', managementCompany: 'Y保守' },
    ]);
    expect(r.unresolvedAliases).toEqual([]);
    expect(r.unmatchedRows).toBe(0);
  });

  it('管理会社の列を事業会社の列と取り違えない', () => {
    // 「会社」だけで拾うと管理会社の列に当たってしまう。
    const r = csv([['IP', '管理会社', '事業会社'], ['10.0.0.1', 'X保守', 'A社']]);
    expect(r.updates[0]).toEqual({ key: '1', businessCompany: 'A事業会社', managementCompany: 'X保守' });
  });

  it('資産を特定する列が無ければ、読めたヘッダを添えて失敗させる', () => {
    expect(() => csv([['事業会社'], ['A社']])).toThrow(/IP か FQDN.*事業会社/s);
  });

  it('会社の列が無ければ失敗させる', () => {
    expect(() => csv([['IP'], ['10.0.0.1']])).toThrow(/事業会社・管理会社/);
  });

  it('空欄は既存値を消さない', () => {
    const cur: RasAsset[] = [{ ...assets[0], businessCompany: 'A事業会社', managementCompany: 'X保守' }];
    const r = planRasCsvImport([['IP', '事業会社', '管理会社'], ['10.0.0.1', '', '']], cur, perms);
    expect(r.updates).toEqual([]); // 変化なし
  });
});

describe('体制表との対応付けと宛名', () => {
  const p = normalizeRasPerms({
    byBusinessCompany: { 'A事業会社': [7], 'B事業会社': [] },
    contactNameByCompany: { 'A事業会社': 'A社（体制表の表記）', '消えた会社': 'X' },
  });

  it('体制表での表記を引ける。未設定なら事業会社名そのもの', () => {
    expect(contactNameFor('A事業会社', p)).toBe('A社（体制表の表記）');
    expect(contactNameFor('B事業会社', p)).toBe('B事業会社');
  });

  it('登録済みの会社にひもづくものだけ持つ', () => {
    expect(contactNameFor('消えた会社', p)).toBe('消えた会社'); // 保存値は捨てられている
  });

  it('本文の書き出しは「〈事業会社名〉事業場ITセキュリティ責任者 〈氏名〉様」。会社名も氏名も体制表から入る', () => {
    expect(greetingFor('A事業会社', '山田 太郎')).toBe('A事業会社 事業場ITセキュリティ責任者 山田 太郎 様');
  });

  it('会社を再登録しても対応付けは消えない', () => {
    expect(mergeCompanies(p, ['A事業会社', 'C事業会社']).contactNameByCompany['A事業会社']).toBe('A社（体制表の表記）');
  });
});

describe('脆弱性種別の判定', () => {
  const sheet = new Set(['CVE-2024-1111', 'CVE-2024-2222']);

  it('CVE対応策一覧に載っている CVE を含むなら CSIRT牽制分', () => {
    expect(classifyVuln(['CVE-2024-1111'], sheet)).toEqual({ kind: VULN_CSIRT, cveIds: 'CVE-2024-1111' });
  });

  it('CSIRT牽制分の CVE ID は「該当した分」だけ（チケットが持つ他の CVE は書かない）', () => {
    // ★チケットの CVE を全部書くと、対応策一覧に無いものまで CSIRT の対象に見える。
    expect(classifyVuln(['CVE-2024-9999', 'CVE-2024-1111'], sheet).cveIds).toBe('CVE-2024-1111');
  });

  it('該当が複数あれば並べる', () => {
    expect(classifyVuln(['CVE-2024-2222', 'CVE-2024-1111'], sheet).cveIds).toBe('CVE-2024-1111, CVE-2024-2222');
  });

  it('一覧に無ければ OS・ミドルウェア検査牽制分。CVE はチケットのものを書く', () => {
    expect(classifyVuln(['CVE-2024-9999'], sheet)).toEqual({ kind: VULN_OS_MW, cveIds: 'CVE-2024-9999' });
  });

  it('OS・ミドルウェア側で CVE が複数あるときは「先頭 他」に畳む', () => {
    expect(classifyVuln(['CVE-2024-8888', 'CVE-2024-9999'], sheet).cveIds).toBe('CVE-2024-8888 他');
  });

  it('CVE を持たないチケットは OS・ミドルウェアで CVE ID は空欄', () => {
    expect(classifyVuln([], sheet)).toEqual({ kind: VULN_OS_MW, cveIds: '' });
  });

  it('大小や前後の空白が違っても突き合わせる', () => {
    expect(classifyVuln([' cve-2024-1111 '], sheet).kind).toBe(VULN_CSIRT);
  });

  it('CVE一覧を読めていない（空）ときは全部 OS・ミドルウェアになる', () => {
    // ★Excel が読めなかった回に全件 CSIRT 扱いになるより、こちらに倒す。
    expect(classifyVuln(['CVE-2024-1111'], new Set()).kind).toBe(VULN_OS_MW);
  });

  it('チケット一覧の組み立てで種別が入る', () => {
    const assets = [{ hostId: 'h1', ip: '10.0.0.1', fqdn: 'a', settenId: 'R100', businessCompany: 'A社',
                      managementCompany: '', aliveStatus: '', registeredAt: '', lastScan: '', trackingMethod: '' }];
    const tk = [{ number: '1', state: 'OPEN', hostId: 'h1', ip: '10.0.0.1', fqdn: 'a',
                  created: '', firstFound: '', lastFound: '', cves: ['CVE-2024-1111'] }];
    expect(deriveRasTickets(tk, assets, {}, sheet)[0].vulnKind).toBe(VULN_CSIRT);
  });
});
