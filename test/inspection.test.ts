import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AG_PATTERN, agPattern, quarterOf, buildTargets, classify, countStatus, weeklySummary,
  pendingAgs, scanRunHits, mapRunHits, scanSchedHits, mapSchedHits, isFinished, computeInspection, buildMatrix,
} from '../src/inspection';
import { parseScanList, parseMapList, parseScanSchedules, parseMapSchedules, parseMapTargets } from '../src/inspection-parse';
import { qualysErrorText } from '../src/qualys';
import { markText } from '../src/ui/views/inspection';
import type { MatrixRow } from '../src/inspection';
import type { QamRecord, QamRecords } from '../src/types';

// AssetGroup スナップショットの最小レコードを作る。
function group(title: string, domains: string[] = [], ips: string[] = ['10.0.0.1']): QamRecord {
  return { key: title, name: title, scalar: { TITLE: title }, set: { DOMAIN_LIST: domains, IPS: ips }, info: {}, hash: '' };
}
const records = (...gs: QamRecord[]): QamRecords => Object.fromEntries(gs.map((g) => [g.key, g]));

describe('quarterOf (年度4月始まり)', () => {
  it('7月は Q2（7/1〜9/30・2026年度）', () => {
    const q = quarterOf(new Date(2026, 6, 18), 4);
    expect(q.q).toBe(2);
    expect(q.fy).toBe(2026);
    expect(q.label).toBe('2026年度 Q2');
    expect(q.start.getMonth()).toBe(6); // 7月
    expect(q.end.getMonth()).toBe(8);   // 9月
    expect(q.end.getDate()).toBe(30);
  });

  it('5月は Q1（4/1〜6/30）', () => {
    const q = quarterOf(new Date(2026, 4, 20), 4);
    expect(q.q).toBe(1);
    expect(q.start.getMonth()).toBe(3);
    expect(q.end.getDate()).toBe(30);
  });

  it('1月は前年度の Q4（1/1〜3/31）＝年度跨ぎ', () => {
    const q = quarterOf(new Date(2027, 0, 15), 4);
    expect(q.q).toBe(4);
    expect(q.fy).toBe(2026); // 年度は前年
    expect(q.start.getMonth()).toBe(0);
    expect(q.end.getMonth()).toBe(2);
    expect(q.end.getDate()).toBe(31);
  });

  it('年度開始月を1月にすると暦年四半期になる', () => {
    const q = quarterOf(new Date(2026, 1, 10), 1);
    expect(q.q).toBe(1);
    expect(q.fy).toBe(2026);
    expect(q.start.getMonth()).toBe(0);
    expect(q.end.getMonth()).toBe(2);
  });

  it('週は7日刻みで、最終週は四半期末で打ち切られる', () => {
    const q = quarterOf(new Date(2026, 6, 18), 4);
    expect(q.weeks[0].label).toBe('第1週 (7/1〜7/7)');
    const last = q.weeks[q.weeks.length - 1];
    expect(last.end.getTime()).toBe(q.end.getTime()); // 末尾は四半期末に一致
    expect(q.weeks.every((w, i) => w.no === i + 1)).toBe(true);
  });
});

describe('agPattern / 対象母集団', () => {
  it('既定パターンは 英字2＋数字3〜4＋末尾D(任意) に一致する', () => {
    const p = agPattern(DEFAULT_AG_PATTERN);
    for (const ok of ['AB123', 'AB1234', 'AB123D', 'AB1234D', 'ab123']) expect(p.test(ok)).toBe(true);
    for (const ng of ['A123', 'ABC123', 'AB12', 'AB12345', 'AB123X', 'AB123DD', '共通AG']) expect(p.test(ng)).toBe(false);
  });

  it('不正な正規表現は既定へフォールバックする', () => {
    expect(agPattern('[').test('AB123')).toBe(true);
  });

  it('パターン一致AGだけをSCAN対象にし、MAP対象は登録ドメインから導出する', () => {
    const recs = records(
      group('AB123', ['example.com', 'sub.example.com']),
      group('CD4567', []),          // ドメイン未登録 → MAP 対象外
      group('共通グループ', ['x.example']), // パターン外 → 対象外
    );
    const { scan, map } = buildTargets(recs, agPattern(DEFAULT_AG_PATTERN));
    expect(scan.map((t) => t.key)).toEqual(['AB123', 'CD4567']);
    expect(map.map((t) => t.key)).toEqual(['example.com', 'sub.example.com']);
    expect(map.every((t) => t.ags.includes('AB123'))).toBe(true);
  });

  it('同じドメインを複数AGが登録していたら両方をぶら下げる', () => {
    const recs = records(group('AB123', ['shared.example']), group('CD456', ['shared.example']));
    const { map } = buildTargets(recs, agPattern(DEFAULT_AG_PATTERN));
    expect(map).toHaveLength(1);
    expect(map[0].ags).toEqual(['AB123', 'CD456']);
  });
});

describe('classify (検査済み / スケジュール済み / 未対応)', () => {
  const q = quarterOf(new Date(2026, 6, 18), 4); // 2026年度Q2: 7/1〜9/30
  const targets = buildTargets(
    records(group('AB123', ['a.example']), group('CD456', []), group('EF789', [])),
    agPattern(DEFAULT_AG_PATTERN),
  ).scan;

  it('四半期内に完了した実施があれば検査済み（実施週も出る）', () => {
    const rows = classify(targets, [{ key: 'AB123', datetime: '2026-07-09T02:00:00Z' }], [], q);
    const ab = rows.find((r) => r.key === 'AB123')!;
    expect(ab.status).toBe('done');
    expect(ab.weekNo).toBe(2); // 7/8〜7/14
  });

  it('四半期外の実施は検査済みにしない', () => {
    const rows = classify(targets, [{ key: 'AB123', datetime: '2026-06-30T02:00:00Z' }], [], q);
    expect(rows.find((r) => r.key === 'AB123')!.status).toBe('pending');
  });

  it('四半期内に予定があるアクティブなスケジュールはスケジュール済み', () => {
    const rows = classify(targets, [], [{ key: 'CD456', nextLaunch: '2026-09-01T02:00:00Z', active: true }], q);
    expect(rows.find((r) => r.key === 'CD456')!.status).toBe('scheduled');
  });

  it('予定が四半期外／無効なスケジュールは未対応のまま', () => {
    const rows = classify(targets, [], [
      { key: 'CD456', nextLaunch: '2026-10-01T02:00:00Z', active: true },  // 四半期外
      { key: 'EF789', nextLaunch: '2026-09-01T02:00:00Z', active: false }, // 無効
    ], q);
    expect(rows.find((r) => r.key === 'CD456')!.status).toBe('pending');
    expect(rows.find((r) => r.key === 'EF789')!.status).toBe('pending');
  });

  it('実施済みはスケジュールより優先し、複数実施なら最新を採る', () => {
    const rows = classify(targets, [
      { key: 'AB123', datetime: '2026-07-05T02:00:00Z' },
      { key: 'AB123', datetime: '2026-08-20T02:00:00Z' },
    ], [{ key: 'AB123', nextLaunch: '2026-09-01T02:00:00Z', active: true }], q);
    const ab = rows.find((r) => r.key === 'AB123')!;
    expect(ab.status).toBe('done');
    expect(ab.doneAt.startsWith('2026-08-20')).toBe(true);
  });

  it('対象キーの照合は大文字小文字・前後空白を無視する', () => {
    const rows = classify(targets, [{ key: ' ab123 ', datetime: '2026-07-09T02:00:00Z' }], [], q);
    expect(rows.find((r) => r.key === 'AB123')!.status).toBe('done');
  });

  it('countStatus が済/予定/未対応を数える', () => {
    const rows = classify(targets, [{ key: 'AB123', datetime: '2026-07-09T02:00:00Z' }],
      [{ key: 'CD456', nextLaunch: '2026-09-01T02:00:00Z', active: true }], q);
    expect(countStatus(rows)).toEqual({ done: 1, scheduled: 1, pending: 1, total: 3 });
  });
});

describe('週次サマリ / 未対応AG', () => {
  const q = quarterOf(new Date(2026, 6, 18), 4);

  it('週ごとの実施件数と累計を返す', () => {
    const targets = buildTargets(records(group('AB123'), group('CD456')), agPattern(DEFAULT_AG_PATTERN)).scan;
    const scan = classify(targets, [
      { key: 'AB123', datetime: '2026-07-02T02:00:00Z' }, // 第1週
      { key: 'CD456', datetime: '2026-07-09T02:00:00Z' }, // 第2週
    ], [], q);
    const sum = weeklySummary(scan, [], q);
    expect(sum[0].scanDone).toBe(1);
    expect(sum[1].scanDone).toBe(1);
    expect(sum[1].scanCum).toBe(2);   // 累計
    expect(sum[2].scanDone).toBe(0);
    expect(sum[2].scanCum).toBe(2);   // 実施が無くても累計は維持
  });

  it('SCAN未対応AGと、未対応ドメインを持つAGを挙げる', () => {
    const recs = records(group('AB123', ['a.example']), group('CD456', ['b.example']));
    const t = buildTargets(recs, agPattern(DEFAULT_AG_PATTERN));
    const scan = classify(t.scan, [{ key: 'CD456', datetime: '2026-07-02T02:00:00Z' }], [], q);
    const map = classify(t.map, [{ key: 'a.example', datetime: '2026-07-02T02:00:00Z' }], [], q);
    const pending = pendingAgs(scan, map);
    expect(pending.map((p) => p.ag)).toEqual(['AB123', 'CD456']);
    expect(pending[0]).toMatchObject({ ag: 'AB123', scanPending: true, mapPendingDomains: [] });
    expect(pending[1]).toMatchObject({ ag: 'CD456', scanPending: false, mapPendingDomains: ['b.example'] });
  });
});

describe('取得内訳（診断）', () => {
  const scansXml = (ag: string) => `<?xml version="1.0"?><SCAN_LIST_OUTPUT><RESPONSE><SCAN_LIST>
    <SCAN><REF>scan/1</REF><LAUNCH_DATETIME>2026-07-09T02:00:00Z</LAUNCH_DATETIME><STATUS><STATE>Finished</STATE></STATUS>
      <ASSET_GROUP_TITLE_LIST><ASSET_GROUP_TITLE>${ag}</ASSET_GROUP_TITLE></ASSET_GROUP_TITLE_LIST>
    </SCAN></SCAN_LIST></RESPONSE></SCAN_LIST_OUTPUT>`;
  const raw = (scans: string) => ({ scans, maps: '', scanSchedules: '', mapSchedules: '', fetchedAt: '2026-07-18T00:00:00Z' });

  it('対象パターンに一致しないAGで検査されていたら unmatched に出る', () => {
    const recs = records(group('AB123'));
    const d = computeInspection(recs, raw(scansXml('ZZ-LEGACY-01')), 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.sources.scanRuns).toBe(1);
    expect(d.sources.scanRunsInQuarter).toBe(1);
    expect(d.sources.unmatchedScanAgs).toEqual(['ZZ-LEGACY-01']); // 対象外AGで実施されている
    expect(d.scan[0].status).toBe('pending');                     // 対象AGは未対応のまま
  });

  it('対象AGで検査されていれば unmatched は空で検査済みになる', () => {
    const d = computeInspection(records(group('AB123')), raw(scansXml('AB123')), 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.sources.unmatchedScanAgs).toEqual([]);
    expect(d.scan[0].status).toBe('done');
  });

  it('四半期外の実施は「うち今四半期」に数えない', () => {
    const old = scansXml('AB123').replace('2026-07-09', '2026-05-09'); // 前四半期
    const d = computeInspection(records(group('AB123')), raw(old), 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.sources.scanRuns).toBe(1);
    expect(d.sources.scanRunsInQuarter).toBe(0);
    expect(d.scan[0].status).toBe('pending');
  });

  it('拠点名付きタイトルでも接続点IDを切り出して対象にする', () => {
    const recs = records(
      group('AB1234D 東京拠点'),   // ID=AB1234D → 対象
      group('CD567 大阪'),         // ID=CD567   → 対象
      group('IJ500'),              // タイトル全体がID → 対象
      group('共通グループ'),        // ID=共通グループ → 対象外
      group('Prod'),               // ID=Prod → 対象外
    );
    const d = computeInspection(recs, null, 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.sources.agTotal).toBe(5);
    expect(d.sources.agMatched).toBe(3);
    // 一覧は AssetGroup タイトルではなく接続点ID で並ぶ
    expect(d.scan.map((r) => r.key)).toEqual(['AB1234D', 'CD567', 'IJ500']);
    // 元のタイトルは参考として保持する
    expect(d.scan[0].titles).toEqual(['AB1234D 東京拠点']);
    // 対象外は「タイトル（ID: 抽出値）」で理由が分かる形にする
    expect(d.sources.agSkipped).toEqual(['Prod（ID: Prod）', '共通グループ（ID: 共通グループ）']);
  });

  it('同一の接続点IDを持つ複数AssetGroupは1件に束ねる', () => {
    const recs = records(group('AB123 東京'), group('AB123 東京(予備)'));
    const d = computeInspection(recs, null, 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.scan).toHaveLength(1);
    expect(d.scan[0].key).toBe('AB123');
    expect(d.scan[0].titles).toEqual(['AB123 東京', 'AB123 東京(予備)']);
  });

  it('スキャン応答のAssetGroupタイトルも接続点IDへ揃えて突合する', () => {
    // Qualys は「AB1234D 東京拠点」というタイトルで返すが、対象キーは接続点ID なので一致させる
    const scans = `<?xml version="1.0"?><SCAN_LIST_OUTPUT><RESPONSE><SCAN_LIST>
      <SCAN><LAUNCH_DATETIME>2026-07-09T02:00:00Z</LAUNCH_DATETIME><STATUS><STATE>Finished</STATE></STATUS>
        <ASSET_GROUP_TITLE_LIST><ASSET_GROUP_TITLE>AB1234D 東京拠点</ASSET_GROUP_TITLE></ASSET_GROUP_TITLE_LIST>
      </SCAN></SCAN_LIST></RESPONSE></SCAN_LIST_OUTPUT>`;
    const d = computeInspection(
      records(group('AB1234D 東京拠点')),
      { scans, maps: '', scanSchedules: '', mapSchedules: '', fetchedAt: '2026-07-18T00:00:00Z' },
      4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18),
    );
    expect(d.scan[0].status).toBe('done');
    expect(d.sources.unmatchedScanAgs).toEqual([]);
  });

  // show_ags=1 を付けないと Qualys は ASSET_GROUP_TITLE_LIST を返さない。
  // その場合「応答はあるのに対象キーへ展開できない」状態になり、全件未対応に見える。
  it('応答にAssetGroup名が無い場合、Rowsは数えるがヒットは0になる（切り分け用）', () => {
    const noAgs = `<?xml version="1.0"?><SCAN_LIST_OUTPUT><RESPONSE><SCAN_LIST>
      <SCAN><REF>scan/1</REF><LAUNCH_DATETIME>2026-07-09T02:00:00Z</LAUNCH_DATETIME>
        <STATUS><STATE>Finished</STATE></STATUS><TARGET>10.0.0.1</TARGET></SCAN>
    </SCAN_LIST></RESPONSE></SCAN_LIST_OUTPUT>`;
    const d = computeInspection(records(group('AB123')), raw(noAgs), 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.sources.scanRunRows).toBe(1); // 応答は読めている
    expect(d.sources.scanRuns).toBe(0);    // だが対象キーへ展開できない
    expect(d.scan[0].status).toBe('pending');
  });

  it('スケジュールマップの対象要素名が版で違っても読める', () => {
    const variants = [
      '<TARGETS><![CDATA[a.example]]></TARGETS>',
      '<SCAN_TARGET>a.example</SCAN_TARGET>',
      '<DOMAIN>a.example</DOMAIN>',
    ];
    for (const target of variants) {
      const xml = `<?xml version="1.0"?><SCHEDULEDSCANS><MAP active="yes" ref="1">${target}
        <NEXTLAUNCH_UTC>2026-09-05T02:00:00Z</NEXTLAUNCH_UTC></MAP></SCHEDULEDSCANS>`;
      expect(mapSchedHits(parseMapSchedules(xml))[0]).toMatchObject({ key: 'a.example', active: true });
    }
  });

  it('未取得(raw=null)でも算出でき、件数は0になる', () => {
    const d = computeInspection(records(group('AB123')), null, 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.sources).toMatchObject({ scanRuns: 0, mapRuns: 0, scanScheds: 0, mapScheds: 0 });
    expect(d.fetchedAt).toBe('');
  });
});

describe('XML パーサ', () => {
  it('実施済みスキャン一覧から AssetGroup と実施日時を読む', () => {
    const xml = `<?xml version="1.0"?><SCAN_LIST_OUTPUT><RESPONSE><SCAN_LIST>
      <SCAN><REF>scan/1</REF><TITLE>Q2 scan</TITLE><LAUNCH_DATETIME>2026-07-09T02:00:00Z</LAUNCH_DATETIME>
        <STATE>Finished</STATE>
        <ASSET_GROUP_TITLE_LIST><ASSET_GROUP_TITLE>AB123</ASSET_GROUP_TITLE><ASSET_GROUP_TITLE>CD456</ASSET_GROUP_TITLE></ASSET_GROUP_TITLE_LIST>
      </SCAN></SCAN_LIST></RESPONSE></SCAN_LIST_OUTPUT>`;
    const runs = parseScanList(xml);
    expect(runs).toHaveLength(1);
    expect(runs[0].assetGroups).toEqual(['AB123', 'CD456']);
    expect(scanRunHits(runs).map((h) => h.key)).toEqual(['AB123', 'CD456']);
  });

  it('未完了のスキャンは実施ヒットにしない', () => {
    const xml = `<?xml version="1.0"?><SCAN_LIST_OUTPUT><SCAN_LIST>
      <SCAN><STATE>Running</STATE><LAUNCH_DATETIME>2026-07-09T02:00:00Z</LAUNCH_DATETIME>
      <ASSET_GROUP_TITLE_LIST><ASSET_GROUP_TITLE>AB123</ASSET_GROUP_TITLE></ASSET_GROUP_TITLE_LIST></SCAN>
    </SCAN_LIST></SCAN_LIST_OUTPUT>`;
    expect(scanRunHits(parseScanList(xml))).toHaveLength(0);
    expect(isFinished('Finished')).toBe(true);
    expect(isFinished('')).toBe(true); // 状態を返さない版は完了扱い
  });

  // 実構造: /msp/map_report_list.php は MAP_REPORT の「属性」で ref/date/domain/status を返す
  // （公式 DTD: map_report_lists.dtd）。子要素形式の版にも備えて両方を検証する。
  it('マップレポート一覧（v1・属性形式）から ドメインと実施日 を読む', () => {
    const attrXml = `<?xml version="1.0"?><MAP_REPORT_LIST user="u" from="2026-01-01T00:00:00Z" to="2026-07-09T02:00:00Z">
      <MAP_REPORT ref="map/1" date="2026-07-09T02:00:00Z" domain="a.example" status="FINISHED">
        <TITLE><![CDATA[Q2 map]]></TITLE>
        <ASSET_GROUPS><ASSET_GROUP><ASSET_GROUP_TITLE>AB123</ASSET_GROUP_TITLE></ASSET_GROUP></ASSET_GROUPS>
      </MAP_REPORT></MAP_REPORT_LIST>`;
    const elemXml = `<?xml version="1.0"?><MAP_REPORT_LIST>
      <MAP_REPORT><REF>map/1</REF><DOMAIN>a.example</DOMAIN><DATETIME>2026-07-09T02:00:00Z</DATETIME><STATE>Finished</STATE></MAP_REPORT>
    </MAP_REPORT_LIST>`;
    for (const xml of [attrXml, elemXml]) {
      const runs = parseMapList(xml);
      expect(runs[0].domain).toBe('a.example');
      expect(mapRunHits(runs)[0].datetime.startsWith('2026-07-09')).toBe(true);
    }
  });

  it('スケジュール済みスキャン（v2）から 次回実行予定 と 有効/無効 を読む', () => {
    const scanXml = `<?xml version="1.0"?><SCHEDULE_SCAN_LIST_OUTPUT><SCHEDULE_SCAN_LIST>
      <SCAN><ID>10</ID><ACTIVE>1</ACTIVE><TITLE>weekly</TITLE>
        <ASSET_GROUP_TITLE_LIST><ASSET_GROUP_TITLE>AB123</ASSET_GROUP_TITLE></ASSET_GROUP_TITLE_LIST>
        <SCHEDULE><NEXTLAUNCH_UTC>2026-09-01T02:00:00Z</NEXTLAUNCH_UTC></SCHEDULE></SCAN>
      <SCAN><ID>11</ID><ACTIVE>0</ACTIVE>
        <ASSET_GROUP_TITLE_LIST><ASSET_GROUP_TITLE>CD456</ASSET_GROUP_TITLE></ASSET_GROUP_TITLE_LIST>
        <SCHEDULE><NEXTLAUNCH_UTC>2026-09-02T02:00:00Z</NEXTLAUNCH_UTC></SCHEDULE></SCAN>
    </SCHEDULE_SCAN_LIST></SCHEDULE_SCAN_LIST_OUTPUT>`;
    const hits = scanSchedHits(parseScanSchedules(scanXml));
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ key: 'AB123', active: true });
    expect(hits[1].active).toBe(false);
  });

  // 実構造: /msp/scheduled_scans.php?type=map は SCHEDULEDSCANS ルート、active="yes" 属性、
  // 対象は TARGETS（カンマ区切り）、NEXTLAUNCH_UTC はタスク直下。
  it('スケジュール済みマップ（v1）は TARGETS のカンマ区切りを展開し active="yes" を解する', () => {
    const mapXml = `<?xml version="1.0"?><SCHEDULEDSCANS>
      <MAP active="yes" ref="11155"><TITLE><![CDATA[Weekly Map]]></TITLE>
        <TARGETS><![CDATA[a.example, b.example]]></TARGETS>
        <SCHEDULE><WEEKLY frequency_weeks="1"/></SCHEDULE>
        <NEXTLAUNCH_UTC>2026-09-05T02:00:00Z</NEXTLAUNCH_UTC></MAP>
      <MAP active="no" ref="11156"><TARGETS><![CDATA[c.example]]></TARGETS>
        <NEXTLAUNCH_UTC>2026-09-06T02:00:00Z</NEXTLAUNCH_UTC></MAP>
    </SCHEDULEDSCANS>`;
    const rows = parseMapSchedules(mapXml);
    expect(rows[0].domains).toEqual(['a.example', 'b.example']);
    const hits = mapSchedHits(rows);
    expect(hits).toHaveLength(3); // 2ドメイン + 1ドメイン
    expect(hits[0]).toMatchObject({ key: 'a.example', active: true });
    expect(hits[2]).toMatchObject({ key: 'c.example', active: false });
  });

  it('v1 が MAP でなく SCAN 要素で返す場合もスケジュールマップとして読める', () => {
    const xml = `<?xml version="1.0"?><SCHEDULEDSCANS>
      <SCAN active="yes" ref="9"><TARGETS><![CDATA[a.example]]></TARGETS>
        <NEXTLAUNCH_UTC>2026-09-05T02:00:00Z</NEXTLAUNCH_UTC></SCAN></SCHEDULEDSCANS>`;
    expect(mapSchedHits(parseMapSchedules(xml))[0]).toMatchObject({ key: 'a.example', active: true });
  });

  it('スケジュール応答を実施一覧として読み違えない', () => {
    const schedXml = `<?xml version="1.0"?><SCHEDULE_SCAN_LIST_OUTPUT><SCHEDULE_SCAN_LIST>
      <SCAN><ID>10</ID></SCAN></SCHEDULE_SCAN_LIST></SCHEDULE_SCAN_LIST_OUTPUT>`;
    expect(parseScanList(schedXml)).toHaveLength(0);
    const v1Sched = `<?xml version="1.0"?><SCHEDULEDSCANS>
      <MAP active="yes" ref="1"><TARGETS>a.example</TARGETS></MAP></SCHEDULEDSCANS>`;
    expect(parseMapList(v1Sched)).toHaveLength(0);
  });
});

describe('Qualys エラー応答の検出', () => {
  it('HTTP 200 でも SIMPLE_RETURN / ERROR はエラーとして扱う', () => {
    expect(qualysErrorText('<?xml version="1.0"?><SIMPLE_RETURN><RESPONSE><TEXT>parameter is not valid</TEXT></RESPONSE></SIMPLE_RETURN>'))
      .toContain('parameter is not valid');
    expect(qualysErrorText('<MAP_REPORT_LIST><ERROR number="999">not authorized</ERROR></MAP_REPORT_LIST>'))
      .toBe('not authorized');
  });
  it('正常な一覧応答はエラーとみなさない', () => {
    expect(qualysErrorText('<SCAN_LIST_OUTPUT><RESPONSE><SCAN_LIST><SCAN><REF>scan/1</REF></SCAN></SCAN_LIST></RESPONSE></SCAN_LIST_OUTPUT>')).toBe('');
    expect(qualysErrorText('<MAP_REPORT_LIST><MAP_REPORT ref="map/1" domain="a.example"/></MAP_REPORT_LIST>')).toBe('');
  });
});

// 実テナントの応答そのままの形（IP はマスク）。要素は SCAN、TYPE=MAP、
// TARGETS は「ドメイン:[ネットブロック]」、NEXTLAUNCH_UTC は Z 無しで SCHEDULE の外。
const REAL_MAP_SCHED = `<?xml version="1.0"?><SCHEDULEDSCANS>
 <SCAN active="yes" ref="1000001">
  <TITLE><![CDATA[AB123_m_20210303]]></TITLE>
  <TARGETS><![CDATA[example.jp:[10.0.0.1, 10.0.0.2]]]></TARGETS>
  <SCHEDULE>
   <WEEKLY frequency_weeks="1" weekdays="1"/>
   <START_DATE_UTC>2021-03-01T15:00:00</START_DATE_UTC>
   <START_HOUR>0</START_HOUR><START_MINUTE>0</START_MINUTE>
   <TIME_ZONE><TIME_ZONE_CODE>JP</TIME_ZONE_CODE></TIME_ZONE>
   <DST_SELECTED>0</DST_SELECTED>
  </SCHEDULE>
  <NEXTLAUNCH_UTC>2026-07-19T15:00:00</NEXTLAUNCH_UTC>
  <ISCANNER_NAME>external</ISCANNER_NAME>
  <TYPE>MAP</TYPE>
  <ASSET_GROUPS><ASSET_GROUP><ASSET_GROUP_TITLE><![CDATA[AB123 拠点名]]></ASSET_GROUP_TITLE></ASSET_GROUP></ASSET_GROUPS>
 </SCAN>
</SCHEDULEDSCANS>`;

describe('スケジュールマップ（実応答フォーマット）', () => {
  it('ドメイン:[ネットブロック] からドメインだけを取り出す', () => {
    expect(parseMapTargets('example.jp:[10.0.0.1, 10.0.0.2]')).toEqual(['example.jp']);
    expect(parseMapTargets('a.example, b.example')).toEqual(['a.example', 'b.example']);
    expect(parseMapTargets('a.example:[10.0.0.1], b.example:[10.0.0.2]')).toEqual(['a.example', 'b.example']);
    expect(parseMapTargets('none:[10.0.0.1-10.0.0.9]')).toEqual([]); // ネットブロックのみは対象外
    expect(parseMapTargets('')).toEqual([]);
  });

  it('SCAN要素・TYPE=MAP・Z無しのNEXTLAUNCH_UTC を正しく読む', () => {
    const rows = parseMapSchedules(REAL_MAP_SCHED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '1000001', active: true, domains: ['example.jp'], assetGroups: ['AB123 拠点名'] });
    expect(rows[0].nextLaunch).toBe('2026-07-19T15:00:00Z'); // Z を補ってUTC扱い
    expect(new Date(rows[0].nextLaunch).toISOString()).toBe('2026-07-19T15:00:00.000Z');
  });

  it('TYPE が SCAN のタスクは混ざっていても除外する', () => {
    const mixed = REAL_MAP_SCHED.replace('<TYPE>MAP</TYPE>', '<TYPE>SCAN</TYPE>');
    expect(parseMapSchedules(mixed)).toHaveLength(0);
  });

  it('登録ドメインと突合してスケジュール済みになる', () => {
    const d = computeInspection(
      records(group('AB123 拠点名', ['example.jp'])),
      { scans: '', maps: '', scanSchedules: '', mapSchedules: REAL_MAP_SCHED, fetchedAt: '2026-07-18T00:00:00Z' },
      4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18),
    );
    expect(d.sources.mapSchedRows).toBe(1);
    expect(d.sources.mapScheds).toBe(1);
    expect(d.map[0].key).toBe('example.jp');
    expect(d.map[0].status).toBe('scheduled');
  });

  it('スケジュールのドメインがDOMAIN_LISTに無くても、接続点IDで補完する', () => {
    // AG には別ドメインだけ登録されている（TARGETS のドメインと不一致）
    const d = computeInspection(
      records(group('AB123 拠点名', ['other.example'])),
      { scans: '', maps: '', scanSchedules: '', mapSchedules: REAL_MAP_SCHED, fetchedAt: '2026-07-18T00:00:00Z' },
      4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18),
    );
    expect(d.map[0].key).toBe('other.example');
    expect(d.map[0].status).toBe('scheduled'); // 接続点 AB123 にマップ予定があるので補完
  });
});

describe('週次サマリ（実施/予約/累計）と統合マトリクス', () => {
  const q = quarterOf(new Date(2026, 6, 18), 4); // Q2: 7/1〜9/30

  // AB123: SCAN実施(第1週) / a.example MAP予約(第3週)
  // CD456: SCAN予約(第2週) / ドメイン無し = MAP対象外
  const build = () => {
    const recs = records(group('AB123 東京', ['a.example']), group('CD456 大阪'));
    const t = buildTargets(recs, agPattern(DEFAULT_AG_PATTERN));
    const scan = classify(t.scan,
      [{ key: 'AB123', datetime: '2026-07-02T02:00:00Z' }],
      [{ key: 'CD456', nextLaunch: '2026-07-09T02:00:00Z', active: true }], q);
    const map = classify(t.map, [], [{ key: 'a.example', nextLaunch: '2026-07-16T02:00:00Z', active: true }], q);
    return { scan, map };
  };

  it('週ごとに実施と予約を分けて数え、累計は実施＋予約で積む', () => {
    const { scan, map } = build();
    const w = weeklySummary(scan, map, q);
    expect(w[0]).toMatchObject({ no: 1, scanDone: 1, scanSched: 0, scanCum: 1, mapDone: 0, mapSched: 0, mapCum: 0 });
    expect(w[1]).toMatchObject({ no: 2, scanDone: 0, scanSched: 1, scanCum: 2 }); // 予約も累計に入る
    expect(w[2]).toMatchObject({ no: 3, mapSched: 1, mapCum: 1 });
    expect(w[3]).toMatchObject({ scanCum: 2, mapCum: 1 }); // 変化が無くても累計は維持
    expect(w[0].period).toBe('7/1〜7/7');
  });

  it('マトリクスは接続点ごとに1行へ統合し、SCANとMAPを併記する', () => {
    const { scan, map } = build();
    const m = buildMatrix(scan, map);
    expect(m.map((r) => r.ag)).toEqual(['AB123', 'CD456']);

    const ab = m[0];
    expect(ab).toMatchObject({ scanStatus: 'done', mapStatus: 'scheduled', scanDoneWeek: 1, scanSchedWeek: null });
    expect(ab.mapSchedWeeks).toEqual([3]);
    expect(ab.domains).toEqual(['a.example']);
    expect(ab.titles).toEqual(['AB123 東京']);

    const cd = m[1];
    expect(cd).toMatchObject({ scanStatus: 'scheduled', mapStatus: null, scanSchedWeek: 2 }); // MAP対象外
    expect(cd.domains).toEqual([]);
  });

  it('MAPは配下ドメインを集約する（1つでも未対応なら未対応）', () => {
    const recs = records(group('AB123 東京', ['a.example', 'b.example']));
    const t = buildTargets(recs, agPattern(DEFAULT_AG_PATTERN));
    const scan = classify(t.scan, [], [], q);
    const map = classify(t.map, [{ key: 'a.example', datetime: '2026-07-02T02:00:00Z' }], [], q);
    expect(buildMatrix(scan, map)[0].mapStatus).toBe('pending'); // b.example が未対応
    const allDone = classify(t.map, [
      { key: 'a.example', datetime: '2026-07-02T02:00:00Z' },
      { key: 'b.example', datetime: '2026-07-03T02:00:00Z' },
    ], [], q);
    expect(buildMatrix(scan, allDone)[0].mapStatus).toBe('done');
  });
});

describe('週セルの表記（絞り込みの値リストに出る）', () => {
  const row = (o: Partial<MatrixRow>): MatrixRow => ({
    ag: 'AB123', titles: [], domains: [], scanStatus: null, mapStatus: null,
    scanDoneWeek: null, scanSchedWeek: null, mapDoneWeeks: [], mapSchedWeeks: [], ...o,
  });

  it('0/1 ではなく S / M と予約を区別できる表記を返す', () => {
    expect(markText(row({ scanDoneWeek: 1 }), 1)).toBe('S');
    expect(markText(row({ scanSchedWeek: 1 }), 1)).toBe('S(予約)');
    expect(markText(row({ mapDoneWeeks: [1] }), 1)).toBe('M');
    expect(markText(row({ mapSchedWeeks: [1] }), 1)).toBe('M(予約)');
    expect(markText(row({ scanDoneWeek: 1, mapDoneWeeks: [1] }), 1)).toBe('S M');
    expect(markText(row({ scanDoneWeek: 1, mapSchedWeeks: [1] }), 1)).toBe('S M(予約)');
    expect(markText(row({ scanDoneWeek: 2 }), 1)).toBe(''); // 別の週には出さない
  });
});

describe('SCAN 対象条件（IP未登録の扱い）', () => {
  const at = (recs: QamRecords) => buildTargets(recs, agPattern(DEFAULT_AG_PATTERN));

  it('接続点IDがDで終わらず IP_SET が未登録なら SCAN 対象外', () => {
    const t = at(records(group('AB123 東京', [], [])));
    expect(t.scan).toHaveLength(0);
    expect(t.scanExcluded).toEqual(['AB123 東京（ID: AB123）']);
  });

  it('IDがDで終わるものは IP 未登録でも SCAN 対象（動的運用）', () => {
    const t = at(records(group('AB123D 東京', [], [])));
    expect(t.scan.map((x) => x.key)).toEqual(['AB123D']);
    expect(t.scanExcluded).toEqual([]);
  });

  it('IP が登録されていれば D で終わらなくても SCAN 対象', () => {
    const t = at(records(group('AB123 東京', [], ['10.0.0.1-10.0.0.9'])));
    expect(t.scan.map((x) => x.key)).toEqual(['AB123']);
  });

  it('SCAN 対象外でも、ドメイン登録があれば MAP 対象には残る', () => {
    const t = at(records(group('AB123 東京', ['a.example'], [])));
    expect(t.scan).toHaveLength(0);
    expect(t.map.map((x) => x.key)).toEqual(['a.example']);
    expect(t.map[0].ags).toEqual(['AB123']); // 所属接続点は保持
  });

  it('同一接続点に複数AGがあり1つでもIP登録があれば対象（除外リストにも出さない）', () => {
    const t = at(records(group('AB123 東京', [], []), group('AB123 東京(予備)', [], ['10.0.0.1'])));
    expect(t.scan.map((x) => x.key)).toEqual(['AB123']);
    expect(t.scanExcluded).toEqual([]);
  });

  it('マトリクスでは SCAN 対象外が「対象外」として出る', () => {
    const d = computeInspection(records(group('AB123 東京', ['a.example'], [])), null, 4, DEFAULT_AG_PATTERN, new Date(2026, 6, 18));
    expect(d.matrix[0]).toMatchObject({ ag: 'AB123', scanStatus: null, mapStatus: 'pending' });
    expect(d.sources.agScanExcluded).toEqual(['AB123 東京（ID: AB123）']);
  });
});
