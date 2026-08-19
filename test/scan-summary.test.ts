import { describe, it, expect } from 'vitest';
import { parseScanSummaryXml, judgeAlive, ipsIn, DEAD_STREAK } from '../src/scan-summary';

// scan_summary_output.dtd に沿った最小の応答。
const scan = (o: {
  ref: string; at: string; status?: string; ag?: string;
  scanned?: string; dead?: string; extra?: string; noResults?: boolean;
}): string =>
  `<SCAN_SUMMARY><SCAN_REFERENCE>${o.ref}</SCAN_REFERENCE>
   <SCAN_INPUT><SCAN_DATETIME>${o.at}</SCAN_DATETIME>
     ${o.ag ? `<TARGETS><ASSET_GROUP_LIST><COUNT>1</COUNT><ASSET_GROUP_DATA><ASSET_GROUP><ID>1</ID><NAME>${o.ag}</NAME></ASSET_GROUP></ASSET_GROUP_DATA></ASSET_GROUP_LIST></TARGETS>` : ''}
   </SCAN_INPUT>
   <SCAN_DETAILS><STATUS>${o.status ?? 'FINISHED'}</STATUS><LAUNCH_DATETIME>${o.at}</LAUNCH_DATETIME></SCAN_DETAILS>
   ${o.noResults ? '' : `<SCAN_RESULTS><HOSTS><HOSTS_DATA>
     ${o.scanned ? `<SCANNED><IP_LIST><IP_DATA><IP_CSV>${o.scanned}</IP_CSV></IP_DATA></IP_LIST></SCANNED>` : ''}
     ${o.dead ? `<DEAD><IP_LIST><IP_DATA><IP_CSV>${o.dead}</IP_CSV></IP_DATA></IP_LIST></DEAD>` : ''}
     ${o.extra ?? ''}
   </HOSTS_DATA></HOSTS></SCAN_RESULTS>`}
   </SCAN_SUMMARY>`;
const doc = (...s: string[]): string =>
  `<?xml version="1.0"?><SCAN_SUMMARY_OUTPUT><RESPONSE><DATETIME>x</DATETIME>
   <SCAN_SUMMARY_LIST>${s.join('')}</SCAN_SUMMARY_LIST></RESPONSE></SCAN_SUMMARY_OUTPUT>`;

describe('IPの取り出し', () => {
  it('CSV と範囲の両方を読む（片方だけだと取りこぼす）', () => {
    const b = '<IP_LIST><IP_DATA><IP_CSV>10.0.0.1, 10.0.0.2</IP_CSV>'
      + '<RANGES><RANGE>10.0.0.5-10.0.0.7</RANGE></RANGES></IP_DATA></IP_LIST>';
    expect(ipsIn(b)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.5', '10.0.0.6', '10.0.0.7']);
  });

  it('IPV4_CSV でも読む', () => {
    expect(ipsIn('<IPV4_LIST><IPV4_DATA><IPV4_CSV>10.0.0.9</IPV4_CSV></IPV4_DATA></IPV4_LIST>')).toEqual(['10.0.0.9']);
  });

  it('空でも落ちない', () => { expect(ipsIn('')).toEqual([]); });
});

describe('スキャン結果の解析', () => {
  it('応答した IP と応答しなかった IP を分けて読む', () => {
    const s = parseScanSummaryXml(doc(scan({ ref: 'scan/1', at: '2026-08-18 03:00:00', ag: 'R100 拠点', scanned: '10.0.0.1', dead: '10.0.0.2' })))[0];
    expect(s.scanned).toEqual(['10.0.0.1']);
    expect(s.dead).toEqual(['10.0.0.2']);
    expect(s.assetGroups).toEqual(['R100 拠点']);
    expect(s.unusable).toBe('');
  });

  it('新しい順に並べる', () => {
    const r = parseScanSummaryXml(doc(
      scan({ ref: 'scan/old', at: '2026-08-16 03:00:00', scanned: '10.0.0.1' }),
      scan({ ref: 'scan/new', at: '2026-08-18 03:00:00', scanned: '10.0.0.1' }),
    ));
    expect(r.map((x) => x.ref)).toEqual(['scan/new', 'scan/old']);
  });

  it('★結果が無いスキャンは判定に使わない（SCAN_RESULTS ごと落ちることがある）', () => {
    expect(parseScanSummaryXml(doc(scan({ ref: 'scan/1', at: '1', noResults: true })))[0].unusable).toBe('結果がありません');
  });

  it('★正常終了していないスキャンは判定に使わない', () => {
    for (const st of ['CANCELED', 'ERROR', 'PAUSED']) {
      expect(parseScanSummaryXml(doc(scan({ ref: 'scan/1', at: '1', status: st, dead: '10.0.0.1' })))[0].unusable).toContain(st);
    }
  });

  it('★接続点まるごと応答なしは判定に使わない（経路の異常を疑う）', () => {
    // 資産が一斉に死ぬより、FW や拠点回線が落ちたと考えるほうが自然。
    const s = parseScanSummaryXml(doc(scan({ ref: 'scan/1', at: '1', scanned: '10.0.0.1', dead: '10.0.0.2,10.0.0.3,10.0.0.4,10.0.0.5' })))[0];
    expect(s.unusable).toContain('スキャン側の異常');
  });

  it('一部だけ応答なしなら普通に使う', () => {
    const s = parseScanSummaryXml(doc(scan({ ref: 'scan/1', at: '1', scanned: '10.0.0.1,10.0.0.2,10.0.0.3', dead: '10.0.0.4' })))[0];
    expect(s.unusable).toBe('');
  });

  it('★スキャン側の失敗カテゴリは応答なしに混ぜない', () => {
    // CANCELLED / ABORTED / FAILED_SLICE_HOSTS などは「ホストが死んでいる」ではない。
    const extra = '<CANCELLED><IP_LIST><IP_DATA><IP_CSV>10.0.0.9</IP_CSV></IP_DATA></IP_LIST></CANCELLED>'
      + '<FAILED_SLICE_HOSTS><IPV4_LIST><IPV4_DATA><IPV4_CSV>10.0.0.8</IPV4_CSV></IPV4_DATA></IPV4_LIST></FAILED_SLICE_HOSTS>';
    const s = parseScanSummaryXml(doc(scan({ ref: 'scan/1', at: '1', scanned: '10.0.0.1,10.0.0.2', dead: '10.0.0.3', extra })))[0];
    expect(s.dead).toEqual(['10.0.0.3']);
    expect(s.scanned).not.toContain('10.0.0.9');
  });

  it('空応答で落ちない', () => { expect(parseScanSummaryXml('')).toEqual([]); });
});

describe('生死の判定', () => {
  const day = (d: string, scanned?: string, dead?: string, over: Partial<Parameters<typeof scan>[0]> = {}) =>
    scan({ ref: `scan/${d}`, at: `2026-08-${d} 03:00:00`, scanned, dead, ...over });

  it('直近が応答ありなら alive', () => {
    const j = judgeAlive(parseScanSummaryXml(doc(day('18', '10.0.0.1'), day('17', undefined, '10.0.0.1,10.0.0.2,10.0.0.3'))));
    expect(j.byIp.get('10.0.0.1')?.verdict).toBe('alive');
  });

  it('★1回だけの応答なしでは変えない（据え置き）', () => {
    // 日次スキャンが1回こけただけで一覧が host not alive で埋まるのを防ぐ。
    const j = judgeAlive(parseScanSummaryXml(doc(day('18', '10.0.0.2,10.0.0.3', '10.0.0.1'), day('17', '10.0.0.1'))));
    expect(j.byIp.get('10.0.0.1')?.verdict).toBe('unknown');
  });

  it('★続けて応答なしなら host not alive', () => {
    const j = judgeAlive(parseScanSummaryXml(doc(
      day('18', '10.0.0.2,10.0.0.3', '10.0.0.1'), day('17', '10.0.0.2,10.0.0.3', '10.0.0.1'),
    )));
    expect(j.byIp.get('10.0.0.1')?.verdict).toBe('dead');
    expect(j.byIp.get('10.0.0.1')?.at).toBe('2026-08-18 03:00:00'); // いつ時点の判定か
  });

  it('★スキャンが1日飛んでも、その日を飛ばして前後で数える', () => {
    // 18日はスキャン自体が無い（＝要素が無い）。17・16 の2回で判定する。
    const j = judgeAlive(parseScanSummaryXml(doc(
      day('17', '10.0.0.2,10.0.0.3', '10.0.0.1'), day('16', '10.0.0.2,10.0.0.3', '10.0.0.1'),
    )));
    expect(j.byIp.get('10.0.0.1')?.verdict).toBe('dead');
  });

  it('★失敗したスキャンは回数に数えない', () => {
    // 18日が異常終了 → 17日の1回だけが有効。まだ streak に届かないので据え置き。
    const j = judgeAlive(parseScanSummaryXml(doc(
      day('18', undefined, '10.0.0.1', { status: 'ERROR' }),
      day('17', '10.0.0.2,10.0.0.3', '10.0.0.1'),
    )));
    expect(j.byIp.get('10.0.0.1')?.verdict).toBe('unknown');
    expect(j.skipped.map((s) => s.ref)).toEqual(['scan/18']);
  });

  it('スキャンに一度も出てこない IP は判定しない', () => {
    const j = judgeAlive(parseScanSummaryXml(doc(day('18', '10.0.0.1'))));
    expect(j.byIp.has('10.9.9.9')).toBe(false);
  });

  it('判定に使わなかったスキャンは理由付きで残す', () => {
    const j = judgeAlive(parseScanSummaryXml(doc(day('18', undefined, undefined, { noResults: true }))));
    expect(j.skipped[0].reason).toBe('結果がありません');
  });

  it('必要回数は 2 回以上にしておく（1回だと据え置きの意味が無い）', () => {
    expect(DEAD_STREAK).toBeGreaterThanOrEqual(2);
  });
});
