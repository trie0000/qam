// Qualys のスケジュール登録（作成のみ・1回実行）のパラメータ組立と入力検証。
// 送信は relay 経由（qualys.ts）。ここは純粋関数のみで、vitest で検証する。
//
// 検査は「検査予定日に1回だけ」実施する運用。Qualys のスケジュールは周期指定が必須のため、
// occurrence=daily & frequency_days=1 に recurrence=1 を合わせて「1回実行したら自動で無効化」
// として表現する（recurrence は v2/v1 両方で対応を確認済み。1〜99 回）。
//
// SCAN は v2: /api/2.0/fo/schedule/scan/?action=create（POST）
//   active={0|1} / asset_groups はタイトルのカンマ区切り
// MAP  は v1: /msp/scheduled_scans.php?add_task=yes&type=map
//   active={yes|no} / 対象は scan_target（ドメインのカンマ区切り）
// 同じ意味の項目でも表記が違うので、内部表現から API ごとに変換する。

export type ScheduleKind = 'scan' | 'map';

export interface ScheduleInput {
  kind: ScheduleKind;
  title: string;
  active: boolean;
  targets: string[];       // SCAN=AssetGroup タイトル / MAP=ドメイン
  optionProfile: string;   // 任意（空ならアカウント既定のプロファイル）
  scannerName: string;     // 任意（空なら既定スキャナー）
  startDate: string;       // 検査予定日 YYYY-MM-DD
  startHour: number;       // 0-23
  startMinute: number;     // 0-59
  timeZoneCode: string;    // 例: JP（大文字）
  observeDst: boolean;
}

export const defaultScheduleInput = (kind: ScheduleKind, startDate: string): ScheduleInput => ({
  kind, title: '', active: false, targets: [], optionProfile: '', scannerName: '',
  startDate, startHour: 2, startMinute: 0, timeZoneCode: 'JP', observeDst: false,
});

const inRange = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;

// 入力の不備を日本語で列挙する（空なら送信可）。Qualys 側で弾かれる前に気付けるようにする。
export function validateSchedule(i: ScheduleInput): string[] {
  const e: string[] = [];
  if (!i.title.trim()) e.push('タイトルを入力してください');
  if (!i.targets.length) e.push(i.kind === 'scan' ? '対象の AssetGroup を入力してください' : '対象のドメインを入力してください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startDate)) e.push('検査予定日を YYYY-MM-DD で指定してください');
  if (!inRange(i.startHour, 0, 23)) e.push('開始時は 0〜23 で指定してください');
  if (!inRange(i.startMinute, 0, 59)) e.push('開始分は 0〜59 で指定してください');
  if (!i.timeZoneCode.trim()) e.push('タイムゾーンコードを入力してください（例: JP）');
  return e;
}

// 1回のみ実行の周期表現（両 API 共通のキー名）。
const ONCE: Record<string, string> = { occurrence: 'daily', frequency_days: '1', recurrence: '1' };

const startTime = (i: ScheduleInput): Record<string, string> => ({
  start_date: i.startDate,
  start_hour: String(i.startHour),
  start_minute: String(i.startMinute),
  time_zone_code: i.timeZoneCode.trim().toUpperCase(),
  observe_dst: i.observeDst ? 'yes' : 'no',
});

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
    ...ONCE,
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
    ...ONCE,
    ...startTime(i),
  });
}

export const scheduleParams = (i: ScheduleInput): Record<string, string> =>
  (i.kind === 'scan' ? buildScanScheduleParams(i) : buildMapScheduleParams(i));

// 送信先パス。relay 側でも許可リストで制限している。
export const SCHEDULE_PATHS: Record<ScheduleKind, string> = {
  scan: '/api/2.0/fo/schedule/scan/',
  map: '/msp/scheduled_scans.php',
};

// 確認モーダルに出す要約（送信前に何が作られるかを一文で示す）。
export function describeSchedule(i: ScheduleInput): string {
  const time = `${String(i.startHour).padStart(2, '0')}:${String(i.startMinute).padStart(2, '0')}`;
  const kind = i.kind === 'scan' ? 'SCAN' : 'MAP';
  const target = i.kind === 'scan' ? `AssetGroup: ${i.targets.join(', ')}` : `ドメイン: ${i.targets.join(', ')}`;
  return `${kind}「${i.title}」／${target}／1回のみ（${i.startDate} ${time} ${i.timeZoneCode}）／`
    + `${i.active ? '有効' : '無効'}で作成`;
}
