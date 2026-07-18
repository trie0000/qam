import { describe, it, expect } from 'vitest';
import {
  defaultScheduleInput, validateSchedule, buildScanScheduleParams, buildMapScheduleParams,
  scheduleParams, describeSchedule, SCHEDULE_PATHS, type ScheduleInput,
} from '../src/schedule';
import { scheduleResult } from '../src/qualys';

const base = (o: Partial<ScheduleInput> = {}): ScheduleInput => ({
  ...defaultScheduleInput('scan', '2026-08-01'),
  title: 'AB123(仮)_20260801', targets: ['AB123(仮)'], ...o,
});

describe('入力検証（1回のみ実行）', () => {
  it('既定値＋タイトルと対象があれば通る', () => {
    expect(validateSchedule(base())).toEqual([]);
  });

  it('タイトルと対象は必須（種別で文言が変わる）', () => {
    expect(validateSchedule(base({ title: ' ' }))).toContain('タイトルを入力してください');
    expect(validateSchedule(base({ targets: [] }))).toContain('対象の AssetGroup を入力してください');
    expect(validateSchedule(base({ kind: 'map', targets: [] }))).toContain('対象のドメインを入力してください');
  });

  it('検査予定日と開始時刻を検査する', () => {
    expect(validateSchedule(base({ startDate: '2026/08/01' }))).toContain('検査予定日を YYYY-MM-DD で指定してください');
    expect(validateSchedule(base({ startHour: 24 }))).toContain('開始時は 0〜23 で指定してください');
    expect(validateSchedule(base({ startMinute: 60 }))).toContain('開始分は 0〜59 で指定してください');
    expect(validateSchedule(base({ timeZoneCode: '' }))).toContain('タイムゾーンコードを入力してください（例: JP）');
  });
});

describe('SCAN スケジュール（v2・1回のみ）のパラメータ', () => {
  it('daily×1回＋recurrence=1 で「1回実行したら無効化」を表現する', () => {
    const p = buildScanScheduleParams(base({ active: true }));
    expect(p).toMatchObject({
      action: 'create', scan_title: 'AB123(仮)_20260801', active: '1',
      asset_groups: 'AB123(仮)',
      occurrence: 'daily', frequency_days: '1', recurrence: '1',
      start_date: '2026-08-01', start_hour: '2', start_minute: '0',
      time_zone_code: 'JP', observe_dst: 'no',
    });
    // 繰り返し系の余計なキーを送らない
    expect(p.weekdays).toBeUndefined();
    expect(p.frequency_weeks).toBeUndefined();
    expect(p.day_of_month).toBeUndefined();
  });

  it('無効で作成すると active=0', () => {
    expect(buildScanScheduleParams(base({ active: false })).active).toBe('0');
  });

  it('未入力の任意項目は送らない（空値で弾かれるのを避ける）', () => {
    const p = buildScanScheduleParams(base({ optionProfile: '', scannerName: '' }));
    expect(p.option_title).toBeUndefined();
    expect(p.iscanner_name).toBeUndefined();
    const q = buildScanScheduleParams(base({ optionProfile: 'Initial Options', scannerName: 'External' }));
    expect(q).toMatchObject({ option_title: 'Initial Options', iscanner_name: 'External' });
  });
});

describe('MAP スケジュール（v1・1回のみ）のパラメータ', () => {
  const map = (o: Partial<ScheduleInput> = {}) => base({ kind: 'map', targets: ['ext-2026-001.jp'], ...o });

  it('add_task/type=map・active は yes/no・recurrence=1', () => {
    const p = buildMapScheduleParams(map({ active: true }));
    expect(p).toMatchObject({
      add_task: 'yes', type: 'map', active: 'yes',
      scan_target: 'ext-2026-001.jp',
      occurrence: 'daily', frequency_days: '1', recurrence: '1',
      time_zone_code: 'JP',
    });
  });

  it('無効で作成すると active=no', () => {
    expect(buildMapScheduleParams(map({ active: false })).active).toBe('no');
  });

  it('オプションプロファイルのキー名は v2 と異なる（option）', () => {
    const p = buildMapScheduleParams(map({ optionProfile: 'Initial Options' }));
    expect(p.option).toBe('Initial Options');
    expect(p.option_title).toBeUndefined();
  });
});

describe('送信先と要約', () => {
  it('種別でパスとパラメータが切り替わる', () => {
    expect(SCHEDULE_PATHS.scan).toBe('/api/2.0/fo/schedule/scan/');
    expect(SCHEDULE_PATHS.map).toBe('/msp/scheduled_scans.php');
    expect(scheduleParams(base()).action).toBe('create');
    expect(scheduleParams(base({ kind: 'map' })).add_task).toBe('yes');
  });

  it('確認用の要約に 対象・1回のみ・日時・有効無効 が入る', () => {
    const s = describeSchedule(base({ active: false }));
    expect(s).toContain('SCAN「AB123(仮)_20260801」');
    expect(s).toContain('AssetGroup: AB123(仮)');
    expect(s).toContain('1回のみ（2026-08-01 02:00 JP）');
    expect(s).toContain('無効で作成');
  });
});

describe('登録応答の成否判定', () => {
  it('v1 の RETURN status で判定する', () => {
    expect(scheduleResult('<GENERIC_RETURN><RETURN status="SUCCESS"><TEXT>New task created</TEXT></RETURN></GENERIC_RETURN>'))
      .toEqual({ ok: true, message: 'New task created' });
    expect(scheduleResult('<GENERIC_RETURN><RETURN status="FAILED"><TEXT>Invalid domain</TEXT></RETURN></GENERIC_RETURN>'))
      .toEqual({ ok: false, message: 'Invalid domain' });
  });

  it('v2 は CODE があればエラー、無ければ成功', () => {
    expect(scheduleResult('<SIMPLE_RETURN><RESPONSE><CODE>1905</CODE><TEXT>parameter is not valid</TEXT></RESPONSE></SIMPLE_RETURN>'))
      .toEqual({ ok: false, message: 'parameter is not valid' });
    expect(scheduleResult('<SIMPLE_RETURN><RESPONSE><TEXT>New scan schedule created</TEXT></RESPONSE></SIMPLE_RETURN>'))
      .toEqual({ ok: true, message: 'New scan schedule created' });
  });

  it('本文が空でも落ちない（成功扱い＋既定メッセージ）', () => {
    expect(scheduleResult('')).toEqual({ ok: true, message: '登録しました' });
  });
});
