// Qualys のスケジュール登録（作成のみ）のパラメータ組立と入力検証。
// 送信は relay 経由（qualys.ts）。ここは純粋関数のみで、vitest で検証する。
//
// SCAN は v2: /api/2.0/fo/schedule/scan/?action=create（POST）
//   active={0|1} / weekdays は小文字 / asset_groups はタイトルのカンマ区切り
// MAP  は v1: /msp/scheduled_scans.php?add_task=yes&type=map
//   active={yes|no} / weekdays は先頭大文字 / 対象は scan_target（ドメインのカンマ区切り）
// 同じ意味の項目でも表記が違うので、内部表現から API ごとに変換する。

export type ScheduleKind = 'scan' | 'map';
export type Occurrence = 'daily' | 'weekly' | 'monthly';

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = typeof WEEKDAYS[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = {
  sunday: '日', monday: '月', tuesday: '火', wednesday: '水', thursday: '木', friday: '金', saturday: '土',
};

export interface ScheduleInput {
  kind: ScheduleKind;
  title: string;
  active: boolean;
  targets: string[];       // SCAN=AssetGroup タイトル / MAP=ドメイン
  optionProfile: string;   // 任意（空ならアカウント既定のプロファイル）
  scannerName: string;     // 任意（空なら既定スキャナー）
  occurrence: Occurrence;
  frequencyDays: number;   // daily
  frequencyWeeks: number;  // weekly
  frequencyMonths: number; // monthly
  weekdays: Weekday[];     // weekly
  dayOfMonth: number;      // monthly
  startDate: string;       // YYYY-MM-DD
  startHour: number;       // 0-23
  startMinute: number;     // 0-59
  timeZoneCode: string;    // 例: JP（大文字）
  observeDst: boolean;
}

export const defaultScheduleInput = (kind: ScheduleKind, startDate: string): ScheduleInput => ({
  kind, title: '', active: false, targets: [], optionProfile: '', scannerName: '',
  occurrence: 'weekly', frequencyDays: 1, frequencyWeeks: 1, frequencyMonths: 1,
  weekdays: ['sunday'], dayOfMonth: 1,
  startDate, startHour: 2, startMinute: 0, timeZoneCode: 'JP', observeDst: false,
});

const inRange = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;

// 入力の不備を日本語で列挙する（空なら送信可）。Qualys 側で弾かれる前に気付けるようにする。
export function validateSchedule(i: ScheduleInput): string[] {
  const e: string[] = [];
  if (!i.title.trim()) e.push('タイトルを入力してください');
  if (!i.targets.length) e.push(i.kind === 'scan' ? '対象の AssetGroup を入力してください' : '対象のドメインを入力してください');
  if (i.occurrence === 'daily' && !inRange(i.frequencyDays, 1, 365)) e.push('日次の間隔は 1〜365 日で指定してください');
  if (i.occurrence === 'weekly') {
    if (!inRange(i.frequencyWeeks, 1, 52)) e.push('週次の間隔は 1〜52 週で指定してください');
    if (!i.weekdays.length) e.push('実行する曜日を1つ以上選んでください');
  }
  if (i.occurrence === 'monthly') {
    if (!inRange(i.frequencyMonths, 1, 12)) e.push('月次の間隔は 1〜12 か月で指定してください');
    if (!inRange(i.dayOfMonth, 1, 31)) e.push('実行日は 1〜31 で指定してください');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startDate)) e.push('開始日を YYYY-MM-DD で指定してください');
  if (!inRange(i.startHour, 0, 23)) e.push('開始時は 0〜23 で指定してください');
  if (!inRange(i.startMinute, 0, 59)) e.push('開始分は 0〜59 で指定してください');
  if (!i.timeZoneCode.trim()) e.push('タイムゾーンコードを入力してください（例: JP）');
  return e;
}

// 周期まわりは v1/v2 で同じキー名なので共通化（曜日の表記だけ差し替える）。
function occurrenceParams(i: ScheduleInput, weekday: (w: Weekday) => string): Record<string, string> {
  const p: Record<string, string> = { occurrence: i.occurrence };
  if (i.occurrence === 'daily') p.frequency_days = String(i.frequencyDays);
  if (i.occurrence === 'weekly') {
    p.frequency_weeks = String(i.frequencyWeeks);
    p.weekdays = i.weekdays.map(weekday).join(',');
  }
  if (i.occurrence === 'monthly') {
    p.frequency_months = String(i.frequencyMonths);
    p.day_of_month = String(i.dayOfMonth);
  }
  return p;
}

const startTime = (i: ScheduleInput): Record<string, string> => ({
  start_date: i.startDate,
  start_hour: String(i.startHour),
  start_minute: String(i.startMinute),
  time_zone_code: i.timeZoneCode.trim().toUpperCase(),
  observe_dst: i.observeDst ? 'yes' : 'no',
});

const lower = (w: Weekday): string => w;
const capitalize = (w: Weekday): string => w.charAt(0).toUpperCase() + w.slice(1);

// 値が空の項目は送らない（Qualys は空値を不正パラメータとして弾くことがある）。
const compact = (p: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null));

// SCAN: v2 /api/2.0/fo/schedule/scan/?action=create
export function buildScanScheduleParams(i: ScheduleInput): Record<string, string> {
  return compact({
    action: 'create',
    scan_title: i.title.trim(),
    active: i.active ? '1' : '0',
    asset_groups: i.targets.map((t) => t.trim()).filter(Boolean).join(','),
    option_title: i.optionProfile.trim(),
    iscanner_name: i.scannerName.trim(),
    ...occurrenceParams(i, lower),
    ...startTime(i),
  });
}

// MAP: v1 /msp/scheduled_scans.php（add_task=yes&type=map）
export function buildMapScheduleParams(i: ScheduleInput): Record<string, string> {
  return compact({
    add_task: 'yes',
    type: 'map',
    scan_title: i.title.trim(),
    active: i.active ? 'yes' : 'no',
    scan_target: i.targets.map((t) => t.trim()).filter(Boolean).join(','),
    option: i.optionProfile.trim(),
    iscanner_name: i.scannerName.trim(),
    ...occurrenceParams(i, capitalize),
    ...startTime(i),
  });
}

export const scheduleParams = (i: ScheduleInput): Record<string, string> =>
  (i.kind === 'scan' ? buildScanScheduleParams(i) : buildMapScheduleParams(i));

// 送信先パス。relay 側でもこの2つ以外は拒否する。
export const SCHEDULE_PATHS: Record<ScheduleKind, string> = {
  scan: '/api/2.0/fo/schedule/scan/',
  map: '/msp/scheduled_scans.php',
};

// 確認モーダルに出す要約（送信前に何が作られるかを一文で示す）。
export function describeSchedule(i: ScheduleInput): string {
  const cycle = i.occurrence === 'daily' ? `${i.frequencyDays}日ごと`
    : i.occurrence === 'weekly' ? `${i.frequencyWeeks}週ごと ${i.weekdays.map((w) => WEEKDAY_LABEL[w]).join('・')}曜`
      : `${i.frequencyMonths}か月ごと ${i.dayOfMonth}日`;
  const time = `${String(i.startHour).padStart(2, '0')}:${String(i.startMinute).padStart(2, '0')}`;
  const kind = i.kind === 'scan' ? 'SCAN' : 'MAP';
  const target = i.kind === 'scan' ? `AssetGroup: ${i.targets.join(', ')}` : `ドメイン: ${i.targets.join(', ')}`;
  return `${kind}「${i.title}」／${target}／${cycle}／${i.startDate} ${time} (${i.timeZoneCode})／`
    + `${i.active ? '有効' : '無効'}で作成`;
}
