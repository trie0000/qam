import { describe, it, expect } from 'vitest';
import {
  defaultScheduleInput, validateSchedule, buildScanScheduleParams, buildMapScheduleParams,
  scheduleParams, describeSchedule, SCHEDULE_PATHS, type ScheduleInput,
} from '../src/schedule';
import { scheduleResult } from '../src/qualys';

const base = (o: Partial<ScheduleInput> = {}): ScheduleInput => ({
  ...defaultScheduleInput('scan', '2026-08-01'),
  title: 'Q2 scan', targets: ['AB123 東京'], ...o,
});

describe('入力検証', () => {
  it('既定値＋タイトルと対象があれば通る', () => {
    expect(validateSchedule(base())).toEqual([]);
  });

  it('タイトルと対象は必須（種別で文言が変わる）', () => {
    expect(validateSchedule(base({ title: ' ' }))).toContain('タイトルを入力してください');
    expect(validateSchedule(base({ targets: [] }))).toContain('対象の AssetGroup を入力してください');
    expect(validateSchedule(base({ kind: 'map', targets: [] }))).toContain('対象のドメインを入力してください');
  });

  it('周期ごとの範囲を検査する', () => {
    expect(validateSchedule(base({ occurrence: 'daily', frequencyDays: 0 }))).toContain('日次の間隔は 1〜365 日で指定してください');
    expect(validateSchedule(base({ occurrence: 'weekly', frequencyWeeks: 53 }))).toContain('週次の間隔は 1〜52 週で指定してください');
    expect(validateSchedule(base({ occurrence: 'weekly', weekdays: [] }))).toContain('実行する曜日を1つ以上選んでください');
    expect(validateSchedule(base({ occurrence: 'monthly', dayOfMonth: 32 }))).toContain('実行日は 1〜31 で指定してください');
  });

  it('開始日時とタイムゾーンを検査する', () => {
    expect(validateSchedule(base({ startDate: '2026/08/01' }))).toContain('開始日を YYYY-MM-DD で指定してください');
    expect(validateSchedule(base({ startHour: 24 }))).toContain('開始時は 0〜23 で指定してください');
    expect(validateSchedule(base({ startMinute: 60 }))).toContain('開始分は 0〜59 で指定してください');
    expect(validateSchedule(base({ timeZoneCode: '' }))).toContain('タイムゾーンコードを入力してください（例: JP）');
  });
});

describe('SCAN スケジュール（v2）のパラメータ', () => {
  it('action=create・active は 0/1・曜日は小文字・対象は asset_groups', () => {
    const p = buildScanScheduleParams(base({ active: true, weekdays: ['sunday', 'wednesday'], frequencyWeeks: 2 }));
    expect(p).toMatchObject({
      action: 'create', scan_title: 'Q2 scan', active: '1',
      asset_groups: 'AB123 東京',
      occurrence: 'weekly', frequency_weeks: '2', weekdays: 'sunday,wednesday',
      start_date: '2026-08-01', start_hour: '2', start_minute: '0',
      time_zone_code: 'JP', observe_dst: 'no',
    });
  });

  it('無効で作成すると active=0', () => {
    expect(buildScanScheduleParams(base({ active: false })).active).toBe('0');
  });

  it('日次・月次はそれぞれのキーだけを送る', () => {
    const d = buildScanScheduleParams(base({ occurrence: 'daily', frequencyDays: 7 }));
    expect(d).toMatchObject({ occurrence: 'daily', frequency_days: '7' });
    expect(d.weekdays).toBeUndefined();
    expect(d.frequency_weeks).toBeUndefined();

    const m = buildScanScheduleParams(base({ occurrence: 'monthly', frequencyMonths: 3, dayOfMonth: 15 }));
    expect(m).toMatchObject({ occurrence: 'monthly', frequency_months: '3', day_of_month: '15' });
  });

  it('未入力の任意項目は送らない（空値で弾かれるのを避ける）', () => {
    const p = buildScanScheduleParams(base({ optionProfile: '', scannerName: '' }));
    expect(p.option_title).toBeUndefined();
    expect(p.iscanner_name).toBeUndefined();
    const q = buildScanScheduleParams(base({ optionProfile: 'Initial Options', scannerName: 'scanner1' }));
    expect(q).toMatchObject({ option_title: 'Initial Options', iscanner_name: 'scanner1' });
  });

  it('対象は複数をカンマ区切りにし、前後空白を落とす', () => {
    const p = buildScanScheduleParams(base({ targets: [' AB123 東京 ', 'CD456 大阪', ' '] }));
    expect(p.asset_groups).toBe('AB123 東京,CD456 大阪');
  });
});

describe('MAP スケジュール（v1）のパラメータ', () => {
  const map = (o: Partial<ScheduleInput> = {}) => base({ kind: 'map', targets: ['example.jp'], ...o });

  it('add_task/type=map・active は yes/no・曜日は先頭大文字・対象は scan_target', () => {
    const p = buildMapScheduleParams(map({ active: true, weekdays: ['sunday'] }));
    expect(p).toMatchObject({
      add_task: 'yes', type: 'map', scan_title: 'Q2 scan', active: 'yes',
      scan_target: 'example.jp',
      occurrence: 'weekly', frequency_weeks: '1', weekdays: 'Sunday',
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

  it('複数ドメインはカンマ区切り', () => {
    expect(buildMapScheduleParams(map({ targets: ['a.example', 'b.example'] })).scan_target).toBe('a.example,b.example');
  });
});

describe('送信先と要約', () => {
  it('種別でパスとパラメータが切り替わる', () => {
    expect(SCHEDULE_PATHS.scan).toBe('/api/2.0/fo/schedule/scan/');
    expect(SCHEDULE_PATHS.map).toBe('/msp/scheduled_scans.php');
    expect(scheduleParams(base()).action).toBe('create');
    expect(scheduleParams(base({ kind: 'map' })).add_task).toBe('yes');
  });

  it('確認用の要約に 対象・周期・開始日時・有効無効 が入る', () => {
    const s = describeSchedule(base({ active: false, weekdays: ['sunday'], startHour: 2, startMinute: 0 }));
    expect(s).toContain('SCAN「Q2 scan」');
    expect(s).toContain('AssetGroup: AB123 東京');
    expect(s).toContain('1週ごと 日曜');
    expect(s).toContain('2026-08-01 02:00 (JP)');
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
