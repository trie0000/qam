// スケジュール登録フォーム（作成のみ）。本番 Qualys への書き込みなので、
// 送信前に必ず内容の要約を確認させる。組立・検証は schedule.ts（純粋関数）に委ねる。
import { el } from '../dom';
import { openModal } from '../modal';
import {
  WEEKDAYS, WEEKDAY_LABEL, defaultScheduleInput, describeSchedule, validateSchedule,
  type Occurrence, type ScheduleInput, type ScheduleKind, type Weekday,
} from '../../schedule';

export interface ScheduleFormOpts {
  today: string;                       // 開始日の既定値（YYYY-MM-DD）
  assetGroups: string[];               // SCAN 対象の候補（AssetGroup タイトル）
  domains: string[];                   // MAP 対象の候補（ドメイン）
  confirm: (summary: string) => Promise<boolean>;
  submit: (input: ScheduleInput) => Promise<string>;   // 成功時のメッセージを返す
  onDone: () => void;
}

const field = (label: string, node: Node, note = ''): HTMLElement =>
  el('div', { class: 'qam-field' }, [
    el('label', {}, [label]),
    node,
    ...(note ? [el('span', { class: 'qam-insp-sec-note' }, [note])] : []),
  ]);

const numInput = (value: number, min: number, max: number): HTMLInputElement =>
  el('input', { class: 'in', type: 'number', min: String(min), max: String(max), value: String(value) }) as HTMLInputElement;

// 候補リスト付きのテキスト入力（カンマ区切りで複数指定）。
function targetInput(id: string, options: string[]): { input: HTMLInputElement; list: HTMLElement } {
  const input = el('input', { class: 'in', list: id, placeholder: 'カンマ区切りで複数指定できます' }) as HTMLInputElement;
  const list = el('datalist', { id });
  options.slice(0, 500).forEach((o) => list.append(el('option', { value: o })));
  return { input, list };
}

export function openScheduleForm(o: ScheduleFormOpts): void {
  let cur: ScheduleInput = defaultScheduleInput('scan', o.today);

  const kind = el('select', { class: 'in' }) as HTMLSelectElement;
  kind.append(el('option', { value: 'scan' }, ['SCAN（AssetGroup 指定）']), el('option', { value: 'map' }, ['MAP（ドメイン指定）']));
  const title = el('input', { class: 'in', placeholder: '例: AB123_scan_2026Q2' }) as HTMLInputElement;
  const active = el('select', { class: 'in' }) as HTMLSelectElement;
  active.append(el('option', { value: 'no' }, ['無効で作成（Qualys で確認してから有効化）']), el('option', { value: 'yes' }, ['有効で作成（次回実行予定に入る）']));
  const scanTarget = targetInput('qam-sched-ag', o.assetGroups);
  const mapTarget = targetInput('qam-sched-dom', o.domains);
  const optionProfile = el('input', { class: 'in', placeholder: '未入力ならアカウント既定のプロファイル' }) as HTMLInputElement;
  const scanner = el('input', { class: 'in', placeholder: '未入力なら既定スキャナー（例: external）' }) as HTMLInputElement;

  const occurrence = el('select', { class: 'in' }) as HTMLSelectElement;
  occurrence.append(el('option', { value: 'daily' }, ['毎日']), el('option', { value: 'weekly' }, ['毎週']), el('option', { value: 'monthly' }, ['毎月']));
  occurrence.value = 'weekly';
  const freqDays = numInput(1, 1, 365);
  const freqWeeks = numInput(1, 1, 52);
  const freqMonths = numInput(1, 1, 12);
  const dayOfMonth = numInput(1, 1, 31);
  const wdBoxes = WEEKDAYS.map((w) => {
    const cb = el('input', { type: 'checkbox', value: w }) as HTMLInputElement;
    cb.checked = w === 'sunday';
    return { w, cb, node: el('label', { class: 'qam-sched-wd' }, [cb, el('span', {}, [WEEKDAY_LABEL[w]])]) };
  });
  const weekdays = el('div', { class: 'qam-sched-wdrow' }, wdBoxes.map((b) => b.node));

  const startDate = el('input', { class: 'in', type: 'date', value: o.today }) as HTMLInputElement;
  const startHour = numInput(2, 0, 23);
  const startMinute = numInput(0, 0, 59);
  const tz = el('input', { class: 'in', value: 'JP' }) as HTMLInputElement;
  const dst = el('input', { type: 'checkbox' }) as HTMLInputElement;

  // 周期・種別に応じて出し入れする行。
  const rowDaily = field('間隔（日）', freqDays, '1〜365。例: 7 なら 7 日ごと。');
  const rowWeekly = field('間隔（週）', freqWeeks, '1〜52。例: 1 なら毎週。');
  const rowWeekdays = field('実行する曜日', weekdays);
  const rowMonthly = field('間隔（月）', freqMonths, '1〜12。');
  const rowDayOfMonth = field('実行日', dayOfMonth, '1〜31。');
  const rowScanTarget = field('対象 AssetGroup', el('div', {}, [scanTarget.input, scanTarget.list]), 'AssetGroup のタイトルを入力（候補から選べます）。');
  const rowMapTarget = field('対象ドメイン', el('div', {}, [mapTarget.input, mapTarget.list]), 'ドメイン名のみ（www. は付けない）。');
  const rowOption = field('オプションプロファイル（任意）', optionProfile);

  const show = (node: HTMLElement, on: boolean): void => { node.hidden = !on; };
  function syncRows(): void {
    const k = kind.value as ScheduleKind;
    show(rowScanTarget, k === 'scan');
    show(rowMapTarget, k === 'map');
    const oc = occurrence.value as Occurrence;
    show(rowDaily, oc === 'daily');
    show(rowWeekly, oc === 'weekly');
    show(rowWeekdays, oc === 'weekly');
    show(rowMonthly, oc === 'monthly');
    show(rowDayOfMonth, oc === 'monthly');
  }
  kind.addEventListener('change', syncRows);
  occurrence.addEventListener('change', syncRows);

  const err = el('div', { class: 'qam-sched-err', hidden: true });
  const body = el('div', {}, [
    el('div', { class: 'qam-insp-sec-note' }, ['Qualys に新しいスケジュールを作成します。作成後の変更・削除は Qualys の画面で行ってください。']),
    field('種別', kind),
    field('タイトル', title),
    rowScanTarget, rowMapTarget,
    field('周期', occurrence),
    rowDaily, rowWeekly, rowWeekdays, rowMonthly, rowDayOfMonth,
    field('開始日', startDate),
    field('開始時刻（時／分）', el('div', { class: 'qam-sched-time' }, [startHour, startMinute])),
    field('タイムゾーンコード', tz, '大文字で指定（例: JP）。'),
    field('夏時間を考慮する', dst),
    field('スキャナー（任意）', scanner),
    rowOption,
    field('作成時の状態', active),
    err,
  ]);
  syncRows();

  const collect = (): ScheduleInput => {
    const k = kind.value as ScheduleKind;
    const raw = (k === 'scan' ? scanTarget.input.value : mapTarget.input.value);
    return {
      ...cur,
      kind: k,
      title: title.value,
      active: active.value === 'yes',
      targets: raw.split(',').map((s) => s.trim()).filter(Boolean),
      optionProfile: optionProfile.value,
      scannerName: scanner.value,
      occurrence: occurrence.value as Occurrence,
      frequencyDays: Number(freqDays.value), frequencyWeeks: Number(freqWeeks.value), frequencyMonths: Number(freqMonths.value),
      weekdays: wdBoxes.filter((b) => b.cb.checked).map((b) => b.w as Weekday),
      dayOfMonth: Number(dayOfMonth.value),
      startDate: startDate.value,
      startHour: Number(startHour.value), startMinute: Number(startMinute.value),
      timeZoneCode: tz.value,
      observeDst: dst.checked,
    };
  };

  const showErrors = (msgs: string[]): void => {
    err.hidden = !msgs.length;
    err.textContent = msgs.join(' / ');
  };

  openModal({
    title: 'スケジュール登録',
    body,
    primaryLabel: '内容を確認して登録',
    // 成功するまでモーダルを閉じない（入力を失わせない）。
    onPrimary: async () => {
      cur = collect();
      const errors = validateSchedule(cur);
      if (errors.length) { showErrors(errors); return false; }
      showErrors([]);
      if (!(await o.confirm(describeSchedule(cur)))) return false;
      try {
        await o.submit(cur);
        o.onDone();
        return true;
      } catch (e) {
        showErrors([(e as Error).message]);
        return false;
      }
    },
  });
}
