import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGIONS, parseRegions, formatRegions, assetGroupTitle, toDnsLabel, domainName,
  classifyIpToken, normalizeIpToken, parseIpInput, parseFqdnInput, isFqdn, containsPrivateIp,
  planProvision, validateProvision, buildAssetGroupParams,
  describeProvision, type ProvisionInput,
} from '../src/provision';

const base = (o: Partial<ProvisionInput> = {}): ProvisionInput => ({
  applicationNo: 'EXT-2026-001', regionCode: 'jp', assetType: 'static', kind: 'both',
  ips: ['203.0.113.1'], dnsNames: [], ...o,
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

describe('検査資産情報の入力（テキスト直接入力）', () => {
  it('単体 / CIDR / レンジ を判別する', () => {
    expect(classifyIpToken('203.0.113.1')).toBe('single');
    expect(classifyIpToken('203.0.113.0/24')).toBe('cidr');
    expect(classifyIpToken('203.0.113.1-203.0.113.99')).toBe('range');
    expect(classifyIpToken('10.0.0.999')).toBeNull();
    expect(classifyIpToken('203.0.113.1/33')).toBeNull();
    expect(classifyIpToken('203.0.113.1-')).toBeNull();
    expect(classifyIpToken('abc')).toBeNull();
  });

  it('レンジの "-" は両端の半角スペースを許し、前後の空白はトリミングする', () => {
    expect(normalizeIpToken('  203.0.113.1 - 203.0.113.99  ')).toBe('203.0.113.1-203.0.113.99');
    expect(classifyIpToken(' 203.0.113.1 - 203.0.113.99 ')).toBe('range');
    expect(normalizeIpToken('  203.0.113.1  ')).toBe('203.0.113.1');
  });

  it('カンマ区切りは分割して複数トークンにする（レンジは展開しない）', () => {
    const r = parseIpInput('203.0.113.1, 203.0.113.0/24 , 203.0.114.1 - 203.0.114.9');
    expect(r.tokens).toEqual(['203.0.113.1', '203.0.113.0/24', '203.0.114.1-203.0.114.9']);
    expect(r.errors).toEqual([]);
  });

  it('書式違反は errors に集め、空要素は無視する', () => {
    const r = parseIpInput('203.0.113.1, , bad, 203.0.113.256');
    expect(r.tokens).toEqual(['203.0.113.1']);
    expect(r.errors).toEqual(['bad', '203.0.113.256']);
  });

  it('FQDN もカンマ区切りで分割し、不正形式だけ errors にする', () => {
    const r = parseFqdnInput(' a.example.jp , bad_host, b.example.jp ');
    expect(r.tokens).toEqual(['a.example.jp', 'b.example.jp']);
    expect(r.errors).toEqual(['bad_host']);
    expect(isFqdn('host1.example.jp')).toBe(true);
    expect(isFqdn('nodot')).toBe(false);
  });

  // "www. を付けない" は MAP の domain= 固有の指定。検査対象ホスト名には適用しない。
  it('www. で始まる FQDN も正当なホスト名として受け付ける', () => {
    const r = parseFqdnInput('www.example.jp, www2.example.jp');
    expect(r.tokens).toEqual(['www.example.jp', 'www2.example.jp']);
    expect(r.errors).toEqual([]);
    expect(validateProvision(dyn({ dnsNames: ['www.example.jp'] }))).toEqual([]);
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
    expect(st.ips).toEqual(['203.0.113.1']);
    expect(st.dnsNames).toEqual([]);
    const dy = planProvision(dyn({ ips: ['203.0.113.1'] }));
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

  it('動的は検査資産情報の FQDN が必須で、不正形式は弾く', () => {
    expect(validateProvision(dyn({ dnsNames: [] }))).toContain('検査資産情報の FQDN を1つ以上入力してください');
    expect(validateProvision(dyn({ dnsNames: ['bad_host'] })).join()).toContain('FQDN の表記が不正です');
  });

  it('不正な IP トークンはまとめて報告する（静的・防御的検証）', () => {
    const errs = validateProvision(base({ ips: ['bad', '203.0.113.1-x'] }));
    expect(errs.filter((e) => e.includes('表記が不正'))).toHaveLength(2);
  });
});

describe('AssetGroup 作成パラメータ', () => {
  it('静的: title / ips / domains を組み立てる（DNS は載せない）', () => {
    const p = buildAssetGroupParams(base({ ips: ['203.0.113.1', '203.0.114.0-203.0.114.99'] }));
    expect(p).toEqual({
      action: 'add',
      title: 'EXT-2026-001(仮)',
      ips: '203.0.113.1,203.0.114.0-203.0.114.99',
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

describe('申請情報の記録（division / comments）', () => {
  it('申請部門は division、件名・申請者・備考は comments に連結して載せる', () => {
    const p = buildAssetGroupParams(base({
      subject: '外部公開に伴う検査', department: '○○部', applicant: '山田', note: '初回',
    }));
    expect(p.division).toBe('○○部');
    expect(p.comments).toBe('件名: 外部公開に伴う検査 / 申請者: 山田 / 備考: 初回');
  });

  it('未入力の申請情報は送らない（部分入力は入っている分だけ）', () => {
    expect(buildAssetGroupParams(base()).division).toBeUndefined();
    expect(buildAssetGroupParams(base()).comments).toBeUndefined();
    expect(buildAssetGroupParams(base({ applicant: '山田' })).comments).toBe('申請者: 山田');
  });

  it('確認の要約に件名が出る', () => {
    expect(describeProvision(base({ subject: 'テスト件名' })).join('\n')).toContain('件名: テスト件名');
  });
});

describe('プライベートIPの拒否', () => {
  it('RFC1918 の各レンジを検出する（単体 / CIDR / レンジの両端）', () => {
    for (const t of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(containsPrivateIp(t)).toBe(true);
    }
    expect(containsPrivateIp('10.0.0.0/8')).toBe(true);
    expect(containsPrivateIp('203.0.113.1-192.168.0.1')).toBe(true); // 終端がプライベート
    expect(containsPrivateIp('192.168.0.1-203.0.113.1')).toBe(true); // 開始がプライベート
  });

  it('グローバルIPは通す（172.15/172.32 は境界外）', () => {
    for (const t of ['203.0.113.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '203.0.113.0/24']) {
      expect(containsPrivateIp(t)).toBe(false);
    }
  });

  it('入力時にプライベートIPは errors へ回し、トークンに入れない', () => {
    const r = parseIpInput('203.0.113.1, 192.168.1.1, 10.0.0.0/8');
    expect(r.tokens).toEqual(['203.0.113.1']);
    expect(r.errors).toEqual(['192.168.1.1（プライベートIP）', '10.0.0.0/8（プライベートIP）']);
  });

  it('検証でもプライベートIPを弾く（直接渡された場合の防御）', () => {
    expect(validateProvision(base({ ips: ['192.168.1.1'] })).join())
      .toContain('プライベートIPは登録できません');
  });
});

describe('複数行入力（改行区切り）', () => {
  it('改行で区切って複数の IP を登録できる', () => {
    const r = parseIpInput('203.0.113.1\n203.0.113.0/24\n203.0.114.1-203.0.114.9');
    expect(r.tokens).toEqual(['203.0.113.1', '203.0.113.0/24', '203.0.114.1-203.0.114.9']);
    expect(r.errors).toEqual([]);
  });

  it('CRLF・タブ・カンマが混在しても分割できる（貼り付け対策）', () => {
    const r = parseIpInput('203.0.113.1,\r\n203.0.113.2\t203.0.113.3\n\n');
    expect(r.tokens).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3']);
    expect(r.errors).toEqual([]);
  });

  it('FQDN も改行区切りで登録できる', () => {
    const r = parseFqdnInput('a.example.jp\nb.example.jp\r\nbad_host');
    expect(r.tokens).toEqual(['a.example.jp', 'b.example.jp']);
    expect(r.errors).toEqual(['bad_host']);
  });

  it('レンジの前後空白は改行区切りでもトリミングされる', () => {
    const r = parseIpInput('  203.0.113.1 - 203.0.113.9  \n 203.0.113.20 ');
    expect(r.tokens).toEqual(['203.0.113.1-203.0.113.9', '203.0.113.20']);
  });
});
