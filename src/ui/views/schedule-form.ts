// 簡易検査（検査登録）フォーム。1 回の登録で次を作る（種別で増減する）:
//   AssetGroup「申請番号(仮)」作成 → ドメイン登録 → SCAN/MAP スケジュール登録
// 左ペインの独立ビューにインラインで置く（モーダルではない）ので、
// 本体（node）と送信処理（submit）を返す形にしてある。
// 本番 Qualys への書き込みなので、送信前に「何が作られるか」を必ず確認させる。
// 命名・パラメータ組立・検証は provision.ts / schedule.ts（純粋関数）に委ねる。
import { el } from '../dom';
import {
  WEEKDAYS, WEEKDAY_LABEL, defaultScheduleInput, validateSchedule,
  type Occurrence, type ScheduleInput, type Weekday,
} from '../../schedule';
import {
  DEFAULT_REGIONS, emptyIpEntry, planProvision, validateProvision, describeProvision,
  type InspectKind, type IpEntry, type ProvisionInput, type RegionOption,
} from '../../provision';

export interface ScheduleDefaults {
  scanOptionProfile: string;
  mapOptionProfile: string;
  scannerAppliance: string;   // 既定 External
  timeZoneCode: string;       // 既定 JP
}

// 登録の実行結果（どこまで進んだかを画面に出す）。
export interface ProvisionResult { steps: string[] }

export interface InspectionFormOpts {
  today: string;
  defaults: ScheduleDefaults;
  regions: RegionOption[];
  confirm: (title: string, lines: string[]) => Promise<boolean>;
  submit: (p: ProvisionInput, scan: ScheduleInput, map: ScheduleInput) => Promise<ProvisionResult>;
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

// 「単体 / レンジ」を切り替えられる IP 入力行。行は動的に増減する。
function ipRow(onChange: () => void, onRemove: (row: HTMLElement) => void): { node: HTMLElement; read: () => IpEntry } {
  const mode = el('select', { class: 'in qam-prov-mode' }) as HTMLSelectElement;
  mode.append(el('option', { value: 'single' }, ['単体']), el('option', { value: 'range' }, ['レンジ']));
  const single = el('input', { class: 'in', placeholder: '10.0.0.1 または 10.0.0.0/24' }) as HTMLInputElement;
  const from = el('input', { class: 'in', placeholder: '開始 10.0.0.1' }) as HTMLInputElement;
  const to = el('input', { class: 'in', placeholder: '終了 10.0.0.99' }) as HTMLInputElement;
  const rangeBox = el('div', { class: 'qam-prov-range' }, [from, el('span', {}, ['〜']), to]);
  const del = el('button', { class: 'btn btn--sm', type: 'button' }, ['削除']);
  const node = el('div', { class: 'qam-prov-row' }, [mode, single, rangeBox, del]);
  const sync = (): void => {
    const isRange = mode.value === 'range';
    single.hidden = isRange;
    rangeBox.hidden = !isRange;
  };
  mode.addEventListener('change', () => { sync(); onChange(); });
  for (const inp of [single, from, to]) inp.addEventListener('input', onChange);
  del.addEventListener('click', () => onRemove(node));
  sync();
  return {
    node,
    read: () => ({ mode: mode.value as IpEntry['mode'], single: single.value, from: from.value, to: to.value }),
  };
}

// DNS 名の入力行（複数）。
function dnsRow(onChange: () => void, onRemove: (row: HTMLElement) => void): { node: HTMLElement; read: () => string } {
  const input = el('input', { class: 'in', placeholder: 'host1.example.jp（www. は付けない）' }) as HTMLInputElement;
  const del = el('button', { class: 'btn btn--sm', type: 'button' }, ['削除']);
  const node = el('div', { class: 'qam-prov-row' }, [input, del]);
  input.addEventListener('input', onChange);
  del.addEventListener('click', () => onRemove(node));
  return { node, read: () => input.value };
}

export function buildInspectionForm(o: InspectionFormOpts): { node: HTMLElement; submit: () => Promise<boolean> } {
  const regions = o.regions.length ? o.regions : DEFAULT_REGIONS;

  // ---- 払い出し（AssetGroup / ドメイン）----
  const appNo = el('input', { class: 'in', placeholder: '例: EXT-2026-001' }) as HTMLInputElement;
  const region = el('select', { class: 'in' }) as HTMLSelectElement;
  regions.forEach((r) => region.append(el('option', { value: r.code }, [`${r.label}（${r.code}）`])));
  const kind = el('select', { class: 'in' }) as HTMLSelectElement;
  kind.append(
    el('option', { value: 'both' }, ['SCAN と MAP の両方']),
    el('option', { value: 'scan' }, ['SCAN のみ']),
    el('option', { value: 'map' }, ['MAP のみ']),
  );

  const ipRows: { node: HTMLElement; read: () => IpEntry }[] = [];
  const dnsRows: { node: HTMLElement; read: () => string }[] = [];
  const ipList = el('div', { class: 'qam-prov-list' });
  const dnsList = el('div', { class: 'qam-prov-list' });
  const preview = el('div', { class: 'qam-prov-preview' });

  const addIp = (): void => {
    const r = ipRow(refreshPreview, (n) => { const i = ipRows.findIndex((x) => x.node === n); if (i >= 0) { ipRows.splice(i, 1); n.remove(); refreshPreview(); } });
    ipRows.push(r); ipList.append(r.node); refreshPreview();
  };
  const addDns = (): void => {
    const r = dnsRow(refreshPreview, (n) => { const i = dnsRows.findIndex((x) => x.node === n); if (i >= 0) { dnsRows.splice(i, 1); n.remove(); refreshPreview(); } });
    dnsRows.push(r); dnsList.append(r.node); refreshPreview();
  };
  const addIpBtn = el('button', { class: 'btn btn--sm', type: 'button' }, ['＋ IP を追加']);
  const addDnsBtn = el('button', { class: 'btn btn--sm', type: 'button' }, ['＋ DNS を追加']);
  addIpBtn.addEventListener('click', addIp);
  addDnsBtn.addEventListener('click', addDns);

  // ---- スケジュール（周期・開始日時）----
  const title = el('input', { class: 'in', placeholder: '未入力なら AssetGroup 名を使います' }) as HTMLInputElement;
  const active = el('select', { class: 'in' }) as HTMLSelectElement;
  active.append(el('option', { value: 'no' }, ['無効で作成（Qualys で確認してから有効化）']), el('option', { value: 'yes' }, ['有効で作成（次回実行予定に入る）']));
  const scanOpt = el('input', { class: 'in', value: o.defaults.scanOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const mapOpt = el('input', { class: 'in', value: o.defaults.mapOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const scanner = el('input', { class: 'in', value: o.defaults.scannerAppliance }) as HTMLInputElement;
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
  const startDate = el('input', { class: 'in', type: 'date', value: o.today }) as HTMLInputElement;
  const startHour = numInput(2, 0, 23);
  const startMinute = numInput(0, 0, 59);
  const tz = el('input', { class: 'in', value: o.defaults.timeZoneCode }) as HTMLInputElement;
  const dst = el('input', { type: 'checkbox' }) as HTMLInputElement;

  const rowDaily = field('間隔（日）', freqDays, '1〜365。');
  const rowWeekly = field('間隔（週）', freqWeeks, '1〜52。');
  const rowWeekdays = field('実行する曜日', el('div', { class: 'qam-sched-wdrow' }, wdBoxes.map((b) => b.node)));
  const rowMonthly = field('間隔（月）', freqMonths, '1〜12。');
  const rowDayOfMonth = field('実行日', dayOfMonth, '1〜31。');
  const rowRegion = field('地域区分', region, 'ドメイン名の末尾に付く地域コードです。');
  const rowScanOpt = field('SCAN のオプションプロファイル', scanOpt);
  const rowMapOpt = field('MAP のオプションプロファイル', mapOpt);

  const readProvision = (): ProvisionInput => ({
    applicationNo: appNo.value,
    regionCode: region.value,
    kind: kind.value as InspectKind,
    ips: ipRows.map((r) => r.read()),
    dnsNames: dnsRows.map((r) => r.read()),
  });

  // 作られるものを常に見せる（送信して初めて分かる、を避ける）。
  function refreshPreview(): void {
    const p = planProvision(readProvision());
    const rows: string[] = [`AssetGroup: ${p.title || '（申請番号を入力）'}`];
    if (p.withMap) rows.push(`ドメイン: ${p.domain || '（申請番号と地域が必要）'}`);
    rows.push(`IP: ${p.ips.length ? p.ips.join(', ') : '（なし）'}`);
    rows.push(`DNS: ${p.dnsNames.length ? p.dnsNames.join(', ') : '（なし）'}`);
    preview.textContent = rows.join('　/　');
  }

  const show = (node: HTMLElement, on: boolean): void => { node.hidden = !on; };
  function syncRows(): void {
    const k = kind.value as InspectKind;
    show(rowRegion, k !== 'scan');
    show(rowScanOpt, k !== 'map');
    show(rowMapOpt, k !== 'scan');
    const oc = occurrence.value as Occurrence;
    show(rowDaily, oc === 'daily');
    show(rowWeekly, oc === 'weekly');
    show(rowWeekdays, oc === 'weekly');
    show(rowMonthly, oc === 'monthly');
    show(rowDayOfMonth, oc === 'monthly');
    refreshPreview();
  }
  kind.addEventListener('change', syncRows);
  occurrence.addEventListener('change', syncRows);
  region.addEventListener('change', refreshPreview);
  appNo.addEventListener('input', refreshPreview);

  const err = el('div', { class: 'qam-sched-err', hidden: true });
  const body = el('div', {}, [
    el('div', { class: 'qam-insp-sec-note' }, [
      'AssetGroup とドメインを作成し、続けて検査スケジュールを登録します。作成後の変更・削除は Qualys の画面で行ってください。',
    ]),
    field('外部接続申請番号', appNo, 'AssetGroup 名は「申請番号(仮)」、ドメイン名は「小文字の申請番号.地域コード」になります。'),
    field('検査種別', kind),
    rowRegion,
    field('SCAN 対象 IP', el('div', {}, [ipList, addIpBtn]), '「単体」は IP か CIDR、「レンジ」は開始〜終了。行を追加して複数指定できます。'),
    field('SCAN 対象 DNS', el('div', {}, [dnsList, addDnsBtn]), '行を追加して複数指定できます。'),
    field('作成される内容', preview),
    field('スケジュールのタイトル（任意）', title),
    field('周期', occurrence),
    rowDaily, rowWeekly, rowWeekdays, rowMonthly, rowDayOfMonth,
    field('開始日', startDate),
    field('開始時刻（時／分）', el('div', { class: 'qam-sched-time' }, [startHour, startMinute])),
    field('タイムゾーンコード', tz),
    field('夏時間を考慮する', dst),
    field('スキャナー', scanner),
    rowScanOpt, rowMapOpt,
    field('作成時の状態', active),
    err,
  ]);
  addIp(); addDns();
  syncRows();

  // 共通のスケジュール項目を組み立て、種別ごとに対象とプロファイルだけ差し替える。
  const readSchedule = (k: 'scan' | 'map', p: ProvisionInput): ScheduleInput => {
    const plan = planProvision(p);
    return {
      ...defaultScheduleInput(k, startDate.value),
      title: title.value.trim() || plan.title,
      active: active.value === 'yes',
      targets: k === 'scan' ? [plan.title] : [plan.domain],
      optionProfile: k === 'scan' ? scanOpt.value : mapOpt.value,
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

  // 送信本体。検証 → 確認 → 実行。成功したら true。
  const submit = async (): Promise<boolean> => {
    const p = readProvision();
    const plan = planProvision(p);
    const scan = readSchedule('scan', p);
    const map = readSchedule('map', p);
    // 払い出しと、実際に作るスケジュールの両方を検証してから確認へ進む。
    const errors = [
      ...validateProvision(p),
      ...(plan.withScan ? validateSchedule(scan) : []),
      ...(plan.withMap ? validateSchedule(map) : []),
    ];
    if (errors.length) { showErrors([...new Set(errors)]); return false; }
    showErrors([]);
    if (!(await o.confirm('この内容で登録しますか？', describeProvision(p)))) return false;
    try {
      await o.submit(p, scan, map);
      o.onDone();
      return true;
    } catch (e) {
      showErrors([(e as Error).message]);
      return false;
    }
  };

  return { node: body, submit };
}
