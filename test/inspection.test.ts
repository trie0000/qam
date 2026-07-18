import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AG_PATTERN, agPattern, quarterOf, buildTargets, classify, countStatus, weeklySummary,
  pendingAgs, scanRunHits, mapRunHits, scanSchedHits, mapSchedHits, isFinished,
} from '../src/inspection';
import { parseScanList, parseMapList, parseScanSchedules, parseMapSchedules } from '../src/inspection-parse';
import type { QamRecord, QamRecords } from '../src/types';

// AssetGroup スナップショットの最小レコードを作る。
function group(title: string, domains: string[] = []): QamRecord {
  return { key: title, name: title, scalar: { TITLE: title }, set: { DOMAIN_LIST: domains }, info: {}, hash: '' };
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

  it('マップ一覧は属性形式（domain/date）でも子要素形式でも読める', () => {
    const attrXml = `<?xml version="1.0"?><MAP_REPORT_LIST_OUTPUT><MAP_REPORT_LIST>
      <MAP_REPORT ref="map/1" date="2026-07-09T02:00:00Z" domain="a.example" status="finished"><TITLE>m</TITLE></MAP_REPORT>
    </MAP_REPORT_LIST></MAP_REPORT_LIST_OUTPUT>`;
    const elemXml = `<?xml version="1.0"?><MAP_REPORT_LIST_OUTPUT><MAP_REPORT_LIST>
      <MAP_REPORT><REF>map/1</REF><DOMAIN>a.example</DOMAIN><DATETIME>2026-07-09T02:00:00Z</DATETIME><STATE>Finished</STATE></MAP_REPORT>
    </MAP_REPORT_LIST></MAP_REPORT_LIST_OUTPUT>`;
    for (const xml of [attrXml, elemXml]) {
      const runs = parseMapList(xml);
      expect(runs[0].domain).toBe('a.example');
      expect(mapRunHits(runs)[0].datetime.startsWith('2026-07-09')).toBe(true);
    }
  });

  it('スケジュール一覧から 次回実行予定 と 有効/無効 を読む', () => {
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

    const mapXml = `<?xml version="1.0"?><SCHEDULE_MAP_LIST_OUTPUT><SCHEDULE_MAP_LIST>
      <MAP><ID>20</ID><ACTIVE>1</ACTIVE><DOMAIN>a.example</DOMAIN>
        <SCHEDULE><NEXTLAUNCH_UTC>2026-09-05T02:00:00Z</NEXTLAUNCH_UTC></SCHEDULE></MAP>
    </SCHEDULE_MAP_LIST></SCHEDULE_MAP_LIST_OUTPUT>`;
    expect(mapSchedHits(parseMapSchedules(mapXml))[0]).toMatchObject({ key: 'a.example', active: true });
  });

  it('スケジュール応答を実施一覧として読み違えない', () => {
    const schedXml = `<?xml version="1.0"?><SCHEDULE_SCAN_LIST_OUTPUT><SCHEDULE_SCAN_LIST>
      <SCAN><ID>10</ID></SCAN></SCHEDULE_SCAN_LIST></SCHEDULE_SCAN_LIST_OUTPUT>`;
    expect(parseScanList(schedXml)).toHaveLength(0);
  });
});
