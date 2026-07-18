import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGIONS, parseRegions, formatRegions, assetGroupTitle, toDnsLabel, domainName,
  ipEntryValue, ipEntryError, planProvision, validateProvision, buildAssetGroupParams,
  describeProvision, emptyIpEntry, type IpEntry, type ProvisionInput,
} from '../src/provision';

const ip = (o: Partial<IpEntry>): IpEntry => ({ ...emptyIpEntry(), ...o });
const base = (o: Partial<ProvisionInput> = {}): ProvisionInput => ({
  applicationNo: 'EXT-2026-001', regionCode: 'jp', kind: 'both',
  ips: [ip({ single: '10.0.0.1' })], dnsNames: ['host1.example.jp'], ...o,
});

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

describe('検査種別と入力検証', () => {
  it('種別に応じて作成対象が変わる', () => {
    expect(planProvision(base({ kind: 'scan' }))).toMatchObject({ withScan: true, withMap: false });
    expect(planProvision(base({ kind: 'map' }))).toMatchObject({ withScan: false, withMap: true });
    expect(planProvision(base({ kind: 'both' }))).toMatchObject({ withScan: true, withMap: true });
  });

  it('正しい入力なら検証を通る', () => {
    expect(validateProvision(base())).toEqual([]);
  });

  it('申請番号は必須。英数字が無いとドメインを作れない', () => {
    expect(validateProvision(base({ applicationNo: ' ' }))).toContain('外部接続申請番号を入力してください');
    expect(validateProvision(base({ applicationNo: '申請' })).join()).toContain('ドメイン名を作れません');
  });

  it('MAP を含むなら地域区分が必須', () => {
    expect(validateProvision(base({ kind: 'map', regionCode: '' }))).toContain('地域区分を選んでください');
    expect(validateProvision(base({ kind: 'scan', regionCode: '' }))).toEqual([]); // SCAN のみなら不要
  });

  it('SCAN を含むなら IP か DNS が1つ以上必要', () => {
    expect(validateProvision(base({ kind: 'scan', ips: [], dnsNames: [] })))
      .toContain('SCAN 対象の IP または DNS を1つ以上入力してください');
    expect(validateProvision(base({ kind: 'map', ips: [], dnsNames: [] }))).toEqual([]); // MAP のみなら不要
  });

  it('AssetGroup 名 "All" と www. 付き DNS を弾く（Qualys の制約）', () => {
    expect(validateProvision(base({ applicationNo: 'All' })).join()).not.toContain('All は使用できません');
    expect(validateProvision(base({ dnsNames: ['www.example.jp'] })).join()).toContain('"www." は付けないでください');
  });

  it('不正な IP 行はまとめて報告する', () => {
    const errs = validateProvision(base({ ips: [ip({ single: 'bad' }), ip({ mode: 'range', from: '10.0.0.1', to: 'x' })] }));
    expect(errs).toHaveLength(2);
  });
});

describe('AssetGroup 作成パラメータ', () => {
  it('title / ips / dns_names / domains を組み立てる', () => {
    const p = buildAssetGroupParams(base({
      ips: [ip({ single: '10.0.0.1' }), ip({ mode: 'range', from: '10.0.1.0', to: '10.0.1.99' })],
      dnsNames: ['a.example.jp', 'b.example.jp'],
    }));
    expect(p).toEqual({
      action: 'add',
      title: 'EXT-2026-001(仮)',
      ips: '10.0.0.1,10.0.1.0-10.0.1.99',
      dns_names: 'a.example.jp,b.example.jp',
      domains: 'ext-2026-001.jp',
    });
  });

  it('SCAN のみなら domains を送らない', () => {
    expect(buildAssetGroupParams(base({ kind: 'scan' })).domains).toBeUndefined();
  });

  it('空の項目は送らない', () => {
    const p = buildAssetGroupParams(base({ kind: 'map', ips: [], dnsNames: [] }));
    expect(p.ips).toBeUndefined();
    expect(p.dns_names).toBeUndefined();
    expect(p).toMatchObject({ action: 'add', title: 'EXT-2026-001(仮)', domains: 'ext-2026-001.jp' });
  });
});

describe('確認用の要約', () => {
  it('作られるものを順に列挙する', () => {
    const lines = describeProvision(base());
    expect(lines[0]).toBe('AssetGroup「EXT-2026-001(仮)」を作成');
    expect(lines.join('\n')).toContain('ドメイン「ext-2026-001.jp」を登録');
    expect(lines.join('\n')).toContain('SCAN スケジュールを登録');
    expect(lines.join('\n')).toContain('MAP スケジュールを登録');
  });

  it('SCAN のみならドメイン登録と MAP スケジュールの行は出さない', () => {
    const s = describeProvision(base({ kind: 'scan' })).join('\n');
    expect(s).toContain('SCAN スケジュールを登録');
    expect(s).not.toContain('MAP スケジュールを登録');
    expect(s).not.toContain('ドメイン「');
  });
});
