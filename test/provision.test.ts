import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGIONS, parseRegions, formatRegions, assetGroupTitle, toDnsLabel, domainName,
  classifyIpToken, normalizeIpToken, parseIpInput, parseFqdnInput, isFqdn, containsPrivateIp,
  planProvision, validateProvision, buildAssetGroupParams,
  describeProvision, buildDomainParams, scheduleTitle, type ProvisionInput,
} from '../src/provision';

// 既定は「SCAN と MAP の両方を実施する IP 資産 1 件」。
const asset = (value: string, scan = true, map = true) => ({ value, scan, map });
const base = (o: Partial<ProvisionInput> = {}): ProvisionInput => ({
  applicationNo: 'EXT-2026-001', regionCode: 'jp', assetType: 'static',
  assets: [asset('203.0.113.1')], ...o,
});
// 動的（FQDN 指定）の入力。
const dyn = (o: Partial<ProvisionInput> = {}): ProvisionInput =>
  base({ assetType: 'dynamic', assets: [asset('host1.example.jp', true, false)], ...o });

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
    expect(validateProvision(dyn({ assets: [asset('www.example.jp', true, false)] }))).toEqual([]);
  });
});

describe('資産ごとの SCAN/MAP 指定と入力検証', () => {
  it('資産ごとのチェックで実施内容が決まる（両方・片方）', () => {
    const both = planProvision(base({ assets: [asset('203.0.113.1', true, true)] }));
    expect(both).toMatchObject({ withScan: true, withMap: true });
    expect(both.scanTargets).toEqual(['203.0.113.1']);
    expect(both.mapTargets).toEqual(['203.0.113.1']);

    const scanOnly = planProvision(base({ assets: [asset('203.0.113.1', true, false)] }));
    expect(scanOnly).toMatchObject({ withScan: true, withMap: false });
    expect(scanOnly.domains).toEqual([]);

    const mapOnly = planProvision(base({ assets: [asset('203.0.113.1', false, true)] }));
    expect(mapOnly).toMatchObject({ withScan: false, withMap: true });
    expect(mapOnly.scanTargets).toEqual([]);
  });

  it('資産ごとに振り分けられる（一部SCAN・一部MAP）', () => {
    const p = planProvision(base({
      assets: [asset('203.0.113.1', true, false), asset('203.0.113.2', false, true), asset('203.0.113.3', true, true)],
    }));
    expect(p.scanTargets).toEqual(['203.0.113.1', '203.0.113.3']);
    expect(p.mapTargets).toEqual(['203.0.113.2', '203.0.113.3']);
  });

  it('静的の MAP は申請番号ベースのドメイン1件＋対象IPをネットブロックにする', () => {
    const p = planProvision(base({ assets: [asset('203.0.113.1', false, true), asset('203.0.113.2', false, true)] }));
    expect(p.domains).toEqual(['ext-2026-001.jp']);
    expect(p.netblocks).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('動的の MAP は FQDN 自体をドメインとして登録する（ネットブロックなし）', () => {
    const p = planProvision(dyn({ assets: [asset('a.example.jp', false, true), asset('b.example.jp', false, true)] }));
    expect(p.domains).toEqual(['a.example.jp', 'b.example.jp']);
    expect(p.netblocks).toEqual([]);
  });

  it('正しい入力なら検証を通る（静的・動的とも）', () => {
    expect(validateProvision(base())).toEqual([]);
    expect(validateProvision(dyn())).toEqual([]);
  });

  it('資産が空、または SCAN/MAP のどちらも未選択なら弾く', () => {
    expect(validateProvision(base({ assets: [] }))).toContain('検査資産情報の IP を1つ以上入力してください');
    expect(validateProvision(dyn({ assets: [] }))).toContain('検査資産情報の FQDN を1つ以上入力してください');
    expect(validateProvision(base({ assets: [asset('203.0.113.1', false, false)] })))
      .toContain('資産ごとに SCAN / MAP のどちらを実施するかを選んでください');
  });

  it('静的で MAP があるときだけ地域区分とドメイン名を検査する', () => {
    expect(validateProvision(base({ regionCode: '' }))).toContain('MAP を実施する資産があるため、地域区分を選んでください');
    // SCAN だけなら地域区分は不要
    expect(validateProvision(base({ regionCode: '', assets: [asset('203.0.113.1', true, false)] }))).toEqual([]);
    // 動的は申請番号からドメインを作らないので影響しない
    expect(validateProvision(dyn({ regionCode: '', applicationNo: '申請' }))).toEqual([]);
  });

  it('不正な IP トークンとプライベートIPはまとめて報告する', () => {
    const errs = validateProvision(base({ assets: [asset('bad'), asset('192.168.1.1')] }));
    expect(errs.join()).toContain('IP の表記が不正です');
    expect(errs.join()).toContain('プライベートIPは登録できません');
  });
});

describe('AssetGroup / ドメインの作成パラメータ', () => {
  it('静的: SCAN 対象だけを ips に載せる（MAP 対象は載せない）', () => {
    const p = buildAssetGroupParams(base({
      assets: [asset('203.0.113.1', true, false), asset('203.0.114.0-203.0.114.99', true, true), asset('203.0.113.9', false, true)],
    }));
    expect(p).toEqual({
      action: 'add',
      title: 'EXT-2026-001(仮)',
      ips: '203.0.113.1,203.0.114.0-203.0.114.99',
    });
  });

  it('動的: SCAN 対象を dns_names に載せる', () => {
    const p = buildAssetGroupParams(dyn({ assets: [asset('a.example.jp', true, false), asset('b.example.jp', false, true)] }));
    expect(p).toEqual({ action: 'add', title: 'EXT-2026-001(仮)', dns_names: 'a.example.jp' });
  });

  it('SCAN 対象が無ければ ips / dns_names を送らない', () => {
    const p = buildAssetGroupParams(base({ assets: [asset('203.0.113.1', false, true)] }));
    expect(p.ips).toBeUndefined();
    expect(p.dns_names).toBeUndefined();
  });

  it('ドメイン登録: 静的はネットブロック付き、動的はドメインのみ', () => {
    const st = buildDomainParams(base({ assets: [asset('203.0.113.1', false, true)] }), 'ext-2026-001.jp');
    expect(st).toEqual({ action: 'add', domain: 'ext-2026-001.jp', netblock: '203.0.113.1' });
    const dy = buildDomainParams(dyn({ assets: [asset('a.example.jp', false, true)] }), 'a.example.jp');
    expect(dy).toEqual({ action: 'add', domain: 'a.example.jp' });
  });
});

describe('スケジュールタイトル', () => {
  it('AssetGroup 名の後ろに _s_ / _m_ と検査予定日を挟む', () => {
    expect(scheduleTitle('EXT-2026-001(仮)', 'scan', '20260801')).toBe('EXT-2026-001(仮)_s_20260801');
    expect(scheduleTitle('EXT-2026-001(仮)', 'map', '20260801')).toBe('EXT-2026-001(仮)_m_20260801');
  });
});

describe('確認用の要約', () => {
  it('静的（両方）は AssetGroup・ドメイン・SCAN/MAP を順に列挙する', () => {
    const lines = describeProvision(base());
    expect(lines[0]).toBe('AssetGroup「EXT-2026-001(仮)」を作成（静的・IP指定）');
    const s = lines.join('\n');
    expect(s).toContain('SCAN 対象（IP_SET）: 203.0.113.1');
    expect(s).toContain('ドメイン「ext-2026-001.jp」を登録（ネットブロック: 203.0.113.1）');
    expect(s).toContain('SCAN スケジュールを登録');
    expect(s).toContain('MAP スケジュールを登録');
  });

  it('動的で SCAN のみならドメイン・MAP は出さない', () => {
    const s = describeProvision(dyn()).join('\n');
    expect(s).toContain('（動的・FQDN指定）');
    expect(s).toContain('SCAN 対象（DNS_LIST）: host1.example.jp');
    expect(s).not.toContain('MAP スケジュールを登録');
    expect(s).not.toContain('ドメイン「');
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
    expect(validateProvision(base({ assets: [asset('192.168.1.1')] })).join())
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
