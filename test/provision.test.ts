import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGIONS, parseRegions, formatRegions, assetGroupTitle, toDnsLabel, domainName,
  ipEntryValue, ipEntryError, planProvision, validateProvision, buildAssetGroupParams,
  describeProvision, emptyIpEntry, type IpEntry, type ProvisionInput,
} from '../src/provision';

const ip = (o: Partial<IpEntry>): IpEntry => ({ ...emptyIpEntry(), ...o });
const base = (o: Partial<ProvisionInput> = {}): ProvisionInput => ({
  applicationNo: 'EXT-2026-001', regionCode: 'jp', assetType: 'static', kind: 'both',
  ips: [ip({ single: '10.0.0.1' })], dnsNames: [], ...o,
});
// 動的（FQDN 指定）の入力。IP は使わない。
const dyn = (o: Partial<ProvisionInput> = {}): ProvisionInput =>
  base({ assetType: 'dynamic', kind: 'scan', ips: [], dnsNames: ['host1.example.jp'], ...o });

describe('地域区分', () => {
  it('既定は6区分で、欧州=eu・中国=cn', () => {
    expect(DEFAULT_REGIONS.map((r) => r.code)).toEqual(['jp', 'na', 'la', 'eu', 'in', 'cn']);
    expect(DEFAULT_REGIONS.find((r) => r.code === 'eu')!.label).toBe('欧州・CIS・中東阿');
  });

  it('設定文字列と相互変換できる', () => {
    const s = formatRegions(DEFAULT_REGIONS);
    expect(s.startsWith('日本=jp,北米=na')).toBe(true);
    expect(parseRegions(s)).toEqual(DEFAULT_REGIONS);
  });

  it('不正な行は捨て、空なら既定へ戻す', () => {
    expect(parseRegions('日本=jp,こわれた,x=,=y')).toEqual([{ label: '日本', code: 'jp' }]);
    expect(parseRegions('')).toEqual(DEFAULT_REGIONS);
    expect(parseRegions('ぜんぶ不正')).toEqual(DEFAULT_REGIONS);
  });
});

describe('命名', () => {
  it('AssetGroup 名は 申請番号+(仮)', () => {
    expect(assetGroupTitle('EXT-2026-001')).toBe('EXT-2026-001(仮)');
    expect(assetGroupTitle('  EXT-1  ')).toBe('EXT-1(仮)');
  });

  it('ドメイン名は 小文字の申請番号+"."+地域コード で、(仮) は含めない', () => {
    expect(domainName('EXT-2026-001', 'jp')).toBe('ext-2026-001.jp');
    expect(domainName('EXT-2026-001', 'eu')).toBe('ext-2026-001.eu');
  });

  it('DNS に使えない文字はハイフンへ落とす（全角・記号）', () => {
    expect(toDnsLabel('EXT_2026/001')).toBe('ext-2026-001');
    expect(toDnsLabel('申請(仮)')).toBe('');           // 英数字が無ければ空
    expect(toDnsLabel('AB－123')).toBe('ab-123');       // 全角ハイフン
    expect(toDnsLabel('--a--b--')).toBe('a-b');         // 前後と連続のハイフンを整理
    expect(toDnsLabel('x'.repeat(80)).length).toBe(63); // 1ラベル上限
  });
});

describe('IP 入力（単体 / レンジ）', () => {
  it('単体は IP か CIDR、レンジは 開始-終了 の形になる', () => {
    expect(ipEntryValue(ip({ single: '10.0.0.1' }))).toBe('10.0.0.1');
    expect(ipEntryValue(ip({ single: '10.0.0.0/24' }))).toBe('10.0.0.0/24');
    expect(ipEntryValue(ip({ mode: 'range', from: '10.0.0.1', to: '10.0.0.9' }))).toBe('10.0.0.1-10.0.0.9');
    expect(ipEntryValue(ip({}))).toBe('');  // 空行
  });

  it('不正な表記はエラーにする', () => {
    expect(ipEntryError(ip({ single: '10.0.0.999' }))).toContain('IP の表記が不正');
    expect(ipEntryError(ip({ single: '10.0.0.1/33' }))).toContain('IP の表記が不正');
    expect(ipEntryError(ip({ mode: 'range', from: '10.0.0.1', to: 'abc' }))).toContain('IP レンジの表記が不正');
    expect(ipEntryError(ip({}))).toBe('');  // 空行はエラーにしない
    expect(ipEntryError(ip({ mode: 'range', from: '', to: '' }))).toBe('');
  });
});

describe('資産種別・検査種別と入力検証', () => {
  it('静的は種別を選べる。動的は常に SCAN のみ（MAP を出さない）', () => {
    expect(planProvision(base({ kind: 'scan' }))).toMatchObject({ withScan: true, withMap: false });
    expect(planProvision(base({ kind: 'map' }))).toMatchObject({ withScan: false, withMap: true });
    expect(planProvision(base({ kind: 'both' }))).toMatchObject({ withScan: true, withMap: true });
    // 動的は kind に何が入っていても scan として扱う
    expect(planProvision(dyn({ kind: 'both' }))).toMatchObject({ withScan: true, withMap: false });
    expect(planProvision(dyn()).domain).toBe('');
  });

  it('静的は IP のみ・動的は FQDN のみを採用する（もう一方は捨てる）', () => {
    const st = planProvision(base({ dnsNames: ['ignored.example.jp'] }));
    expect(st.ips).toEqual(['10.0.0.1']);
    expect(st.dnsNames).toEqual([]);
    const dy = planProvision(dyn({ ips: [ip({ single: '10.0.0.1' })] }));
    expect(dy.ips).toEqual([]);
    expect(dy.dnsNames).toEqual(['host1.example.jp']);
  });

  it('正しい入力なら検証を通る（静的・動的とも）', () => {
    expect(validateProvision(base())).toEqual([]);
    expect(validateProvision(dyn())).toEqual([]);
  });

  it('申請番号は必須。MAP を含むときだけドメイン名を検査する', () => {
    expect(validateProvision(base({ applicationNo: ' ' }))).toContain('外部接続申請番号を入力してください');
    expect(validateProvision(base({ applicationNo: '申請' })).join()).toContain('ドメイン名を作れません');
    // SCAN のみ・動的では英数字なしでもドメインの指摘は出ない
    expect(validateProvision(base({ applicationNo: '申請', kind: 'scan' })).join()).not.toContain('ドメイン名');
    expect(validateProvision(dyn({ applicationNo: '申請' })).join()).not.toContain('ドメイン名');
  });

  it('MAP を含むなら地域区分が必須（動的は不要）', () => {
    expect(validateProvision(base({ kind: 'map', regionCode: '' }))).toContain('地域区分を選んでください');
    expect(validateProvision(base({ kind: 'scan', regionCode: '' }))).toEqual([]);
    expect(validateProvision(dyn({ regionCode: '' }))).toEqual([]);
  });

  it('静的は検査資産情報の IP が必須（DNS では代用できない）', () => {
    expect(validateProvision(base({ ips: [], dnsNames: ['a.example.jp'] })))
      .toContain('検査資産情報の IP を1つ以上入力してください');
  });

  it('動的は検査資産情報の FQDN が必須で、www. 付きは弾く', () => {
    expect(validateProvision(dyn({ dnsNames: [] }))).toContain('検査資産情報の FQDN を1つ以上入力してください');
    expect(validateProvision(dyn({ dnsNames: ['www.example.jp'] })).join()).toContain('"www." は付けないでください');
  });

  it('不正な IP 行はまとめて報告する（静的）', () => {
    const errs = validateProvision(base({ ips: [ip({ single: 'bad' }), ip({ mode: 'range', from: '10.0.0.1', to: 'x' })] }));
    expect(errs.filter((e) => e.includes('表記が不正'))).toHaveLength(2);
  });
});

describe('AssetGroup 作成パラメータ', () => {
  it('静的: title / ips / domains を組み立てる（DNS は載せない）', () => {
    const p = buildAssetGroupParams(base({
      ips: [ip({ single: '10.0.0.1' }), ip({ mode: 'range', from: '10.0.1.0', to: '10.0.1.99' })],
    }));
    expect(p).toEqual({
      action: 'add',
      title: 'EXT-2026-001(仮)',
      ips: '10.0.0.1,10.0.1.0-10.0.1.99',
      domains: 'ext-2026-001.jp',
    });
  });

  it('静的で SCAN のみなら domains を送らない', () => {
    expect(buildAssetGroupParams(base({ kind: 'scan' })).domains).toBeUndefined();
  });

  it('動的: dns_names のみ（ips / domains を送らない）', () => {
    const p = buildAssetGroupParams(dyn({ dnsNames: ['a.example.jp', 'b.example.jp'] }));
    expect(p).toEqual({
      action: 'add',
      title: 'EXT-2026-001(仮)',
      dns_names: 'a.example.jp,b.example.jp',
    });
  });
});

describe('確認用の要約', () => {
  it('静的（両方）は AssetGroup・ドメイン・SCAN/MAP を順に列挙する', () => {
    const lines = describeProvision(base());
    expect(lines[0]).toBe('AssetGroup「EXT-2026-001(仮)」を作成（静的・IP資産）');
    expect(lines.join('\n')).toContain('ドメイン「ext-2026-001.jp」を登録');
    expect(lines.join('\n')).toContain('SCAN スケジュールを登録');
    expect(lines.join('\n')).toContain('MAP スケジュールを登録');
  });

  it('動的は FQDN と SCAN だけ（ドメイン・MAP は出さない）', () => {
    const s = describeProvision(dyn()).join('\n');
    expect(s).toContain('（動的・FQDN指定）');
    expect(s).toContain('FQDN: host1.example.jp');
    expect(s).toContain('SCAN スケジュールを登録');
    expect(s).not.toContain('MAP スケジュールを登録');
    expect(s).not.toContain('ドメイン「');
  });
});
