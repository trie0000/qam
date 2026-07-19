// 簡易検査（検査登録）フォーム。1 回の登録で次を作る（資産種別・検査種別で増減する）:
//   AssetGroup「申請番号(仮)」作成 → （MAP のとき）ドメイン登録 → SCAN/MAP スケジュール登録
// 検査は「検査予定日に1回だけ」実行する運用のため、繰り返し（周期）の設定は持たない。
// 左ペインの独立ビューにインラインで置くので、本体（node）と送信処理（submit）を返す。
// 本番 Qualys への書き込みなので、送信前に「何が作られるか」を必ず確認させる。
// 命名・パラメータ組立・検証は provision.ts / schedule.ts（純粋関数）に委ねる。
import { el } from '../dom';
import { defaultScheduleInput, validateSchedule, type ScheduleInput } from '../../schedule';
import {
  DEFAULT_REGIONS, planProvision, validateProvision, describeProvision,
  type AssetType, type InspectKind, type IpEntry, type ProvisionInput, type RegionOption,
} from '../../provision';

export interface ScheduleDefaults {
  scanOptionProfile: string;
  mapOptionProfile: string;
  scannerAppliance: string;   // 既定 External
  timeZoneCode: string;       // 既定 JP
}

// 登録の実行結果（どこまで進んだかを画面に出す）。
export interface ProvisionResult { steps: string[] }

// 登録モード。qualys=Qualys へ実登録 / ledger=Qualys には登録せず QAM の管理表だけ更新。
export type RegisterMode = 'qualys' | 'ledger';

export interface InspectionFormOpts {
  today: string;
  author: string;          // 申請者の既定値（記入者名）
  initial?: ProvisionInput; // 履歴からの再登録用プリフィル（予定日は today のまま）
  defaults: ScheduleDefaults;
  regions: RegionOption[];
  confirm: (title: string, lines: string[]) => Promise<boolean>;
  submit: (mode: RegisterMode, p: ProvisionInput, scan: ScheduleInput, map: ScheduleInput) => Promise<ProvisionResult>;
  onDone: () => void;
}

// セクション見出し（申請情報 / 検査対象 / 検査スケジュール / その他）。
const section = (title: string): HTMLElement => el('div', { class: 'qam-form-sec' }, [title]);

const field = (label: string, node: Node, note = ''): HTMLElement =>
  el('div', { class: 'qam-field' }, [
    el('label', {}, [label]),
    node,
    ...(note ? [el('span', { class: 'qam-insp-sec-note' }, [note])] : []),
  ]);

const numInput = (value: number, min: number, max: number): HTMLInputElement =>
  el('input', { class: 'in', type: 'number', min: String(min), max: String(max), value: String(value) }) as HTMLInputElement;

// 「単体 / レンジ」を切り替えられる IP 入力行。行は動的に増減する。
function ipRow(onChange: () => void, onRemove: (row: HTMLElement) => void, init?: IpEntry): { node: HTMLElement; read: () => IpEntry } {
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
  if (init) { mode.value = init.mode; single.value = init.single; from.value = init.from; to.value = init.to; }
  mode.addEventListener('change', () => { sync(); onChange(); });
  for (const inp of [single, from, to]) inp.addEventListener('input', onChange);
  del.addEventListener('click', () => onRemove(node));
  sync();
  return {
    node,
    read: () => ({ mode: mode.value as IpEntry['mode'], single: single.value, from: from.value, to: to.value }),
  };
}

// FQDN の入力行（動的・複数）。
function fqdnRow(onChange: () => void, onRemove: (row: HTMLElement) => void, init?: string): { node: HTMLElement; read: () => string } {
  const input = el('input', { class: 'in', placeholder: 'host1.example.jp（www. は付けない）' }) as HTMLInputElement;
  if (init) input.value = init;
  const del = el('button', { class: 'btn btn--sm', type: 'button' }, ['削除']);
  const node = el('div', { class: 'qam-prov-row' }, [input, del]);
  input.addEventListener('input', onChange);
  del.addEventListener('click', () => onRemove(node));
  return { node, read: () => input.value };
}

// 検査予定日(YYYY-MM-DD) → タイトル用 YYYYMMDD。
const ymd = (iso: string): string => (iso || '').replace(/-/g, '');

export function buildInspectionForm(o: InspectionFormOpts): { node: HTMLElement; submit: () => Promise<boolean> } {
  const regions = o.regions.length ? o.regions : DEFAULT_REGIONS;

  // ---- 登録モード ----
  const regMode = el('select', { class: 'in' }) as HTMLSelectElement;
  regMode.append(
    el('option', { value: 'qualys' }, ['Qualys へ登録する']),
    el('option', { value: 'ledger' }, ['管理表のみ更新（Qualys へは登録しない）']),
  );

  // ---- 資産種別・払い出し（AssetGroup / ドメイン）----
  const assetType = el('select', { class: 'in' }) as HTMLSelectElement;
  assetType.append(
    el('option', { value: 'static' }, ['静的（IP 資産）']),
    el('option', { value: 'dynamic' }, ['動的（FQDN 指定）']),
  );
  const appNo = el('input', { class: 'in', placeholder: '例: EXT-2026-001' }) as HTMLInputElement;
  const subject = el('input', { class: 'in', placeholder: '例: ○○システム 外部公開に伴う検査' }) as HTMLInputElement;
  const department = el('input', { class: 'in', placeholder: '例: ○○部' }) as HTMLInputElement;
  const applicant = el('input', { class: 'in', value: o.author }) as HTMLInputElement;
  const note = el('textarea', { class: 'in qam-prov-note', rows: '3', placeholder: '補足があれば記入' }) as HTMLTextAreaElement;
  const region = el('select', { class: 'in' }) as HTMLSelectElement;
  regions.forEach((r) => region.append(el('option', { value: r.code }, [`${r.label}（${r.code}）`])));
  const kind = el('select', { class: 'in' }) as HTMLSelectElement;
  kind.append(
    el('option', { value: 'both' }, ['SCAN と MAP の両方']),
    el('option', { value: 'scan' }, ['SCAN のみ']),
    el('option', { value: 'map' }, ['MAP のみ']),
  );

  const ipRows: { node: HTMLElement; read: () => IpEntry }[] = [];
  const fqdnRows: { node: HTMLElement; read: () => string }[] = [];
  const ipList = el('div', { class: 'qam-prov-list' });
  const fqdnList = el('div', { class: 'qam-prov-list' });
  const preview = el('div', { class: 'qam-prov-preview' });

  const addIp = (init?: IpEntry): void => {
    const r = ipRow(refreshPreview, (n) => { const i = ipRows.findIndex((x) => x.node === n); if (i >= 0) { ipRows.splice(i, 1); n.remove(); refreshPreview(); } }, init);
    ipRows.push(r); ipList.append(r.node); refreshPreview();
  };
  const addFqdn = (init?: string): void => {
    const r = fqdnRow(refreshPreview, (n) => { const i = fqdnRows.findIndex((x) => x.node === n); if (i >= 0) { fqdnRows.splice(i, 1); n.remove(); refreshPreview(); } }, init);
    fqdnRows.push(r); fqdnList.append(r.node); refreshPreview();
  };
  const addIpBtn = el('button', { class: 'btn btn--sm', type: 'button' }, ['＋ IP を追加']);
  const addFqdnBtn = el('button', { class: 'btn btn--sm', type: 'button' }, ['＋ FQDN を追加']);
  addIpBtn.addEventListener('click', () => addIp());
  addFqdnBtn.addEventListener('click', () => addFqdn());

  // ---- スケジュール（1回のみ: 検査予定日と開始時刻だけ）----
  const title = el('input', { class: 'in', placeholder: 'AssetGroup名_YYYYMMDD が自動で入ります' }) as HTMLInputElement;
  const active = el('select', { class: 'in' }) as HTMLSelectElement;
  active.append(el('option', { value: 'no' }, ['無効で作成（Qualys で確認してから有効化）']), el('option', { value: 'yes' }, ['有効で作成（検査予定日に実行される）']));
  const scanOpt = el('input', { class: 'in', value: o.defaults.scanOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const mapOpt = el('input', { class: 'in', value: o.defaults.mapOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const scanner = el('input', { class: 'in', value: o.defaults.scannerAppliance }) as HTMLInputElement;
  const startDate = el('input', { class: 'in', type: 'date', value: o.today }) as HTMLInputElement;
  const startHour = numInput(2, 0, 23);
  const startMinute = numInput(0, 0, 59);

  const rowKind = field('検査種別', kind, 'MAP と SCAN の両方／MAP 単体／SCAN 単体。');
  const rowState = field('作成時の状態', active);
  const rowRegion = field('地域区分', region, 'ドメイン名の末尾に付く地域コードです。');
  const rowIp = field('検査資産情報（IP）', el('div', {}, [ipList, addIpBtn]),
    '「単体」は IP か CIDR、「レンジ」は開始〜終了。行を追加して複数指定できます。AssetGroup の IP_SET に登録されます。');
  const rowFqdn = field('検査資産情報（FQDN）', el('div', {}, [fqdnList, addFqdnBtn]),
    '行を追加して複数指定できます。AssetGroup の DNS_LIST に登録されます。');
  const rowScanOpt = field('SCAN のオプションプロファイル', scanOpt, '共通設定の既定値が入っています。');
  const rowMapOpt = field('MAP のオプションプロファイル', mapOpt, '共通設定の既定値が入っています。');
  const rowScanner = field('スキャナー', scanner, '共通設定の既定値が入っています。');
  // 通常は触らない項目なので折りたたんでおく（開いた状態は保持しない＝毎回閉じる）。
  const optBody = el('div', { class: 'qam-prov-optbody', hidden: true }, [rowScanner, rowScanOpt, rowMapOpt]);
  const optToggle = el('button', { class: 'btn btn--sm', type: 'button' }, ['オプション設定 ▸']);
  optToggle.addEventListener('click', () => {
    optBody.hidden = !optBody.hidden;
    optToggle.textContent = optBody.hidden ? 'オプション設定 ▸' : 'オプション設定 ▾';
  });
  const optSection = el('div', { class: 'qam-prov-opt' }, [optToggle, optBody]);

  const readProvision = (): ProvisionInput => ({
    applicationNo: appNo.value,
    regionCode: region.value,
    assetType: assetType.value as AssetType,
    kind: kind.value as InspectKind,
    ips: ipRows.map((r) => r.read()),
    dnsNames: fqdnRows.map((r) => r.read()),
    subject: subject.value,
    department: department.value,
    applicant: applicant.value,
    note: note.value,
  });

  // スケジュールタイトルの既定値: AssetGroup 名 + "_" + 検査予定日(YYYYMMDD)。
  // 申請番号・予定日に追従するが、利用者が手で書き換えた値は上書きしない。
  let titleAuto = '';
  const syncTitle = (): void => {
    const plan = planProvision(readProvision());
    const next = plan.title && ymd(startDate.value) ? `${plan.title}_${ymd(startDate.value)}` : '';
    if (title.value === titleAuto) title.value = next;
    titleAuto = next;
  };

  // 作られるものを常に見せる（送信して初めて分かる、を避ける）。
  function refreshPreview(): void {
    const p = planProvision(readProvision());
    const rows: string[] = [`AssetGroup: ${p.title || '（申請番号を入力）'}`];
    if (p.withMap) rows.push(`ドメイン: ${p.domain || '（申請番号と地域が必要）'}`);
    if (assetType.value === 'static') rows.push(`IP: ${p.ips.length ? p.ips.join(', ') : '（なし）'}`);
    else rows.push(`FQDN: ${p.dnsNames.length ? p.dnsNames.join(', ') : '（なし）'}`);
    preview.textContent = rows.join('　/　');
  }

  const show = (node: HTMLElement, on: boolean): void => { node.hidden = !on; };
  function syncRows(): void {
    const isDyn = assetType.value === 'dynamic';
    const p = planProvision(readProvision());
    // 動的は SCAN 固定なので検査種別・地域は出さない。検査資産情報は IP↔FQDN を入れ替える。
    show(rowKind, !isDyn);
    show(rowRegion, p.withMap);
    show(rowIp, !isDyn);
    show(rowFqdn, isDyn);
    const isLedger = regMode.value === 'ledger';
    // 管理表のみ更新では Qualys へ送る項目（スキャナー/プロファイル/作成時の状態）は無関係なので隠す。
    show(optSection, !isLedger);
    show(rowState, !isLedger);
    show(rowScanOpt, p.withScan);
    show(rowMapOpt, p.withMap);
    refreshPreview();
    syncTitle();
  }
  regMode.addEventListener('change', syncRows);
  assetType.addEventListener('change', syncRows);
  kind.addEventListener('change', syncRows);
  region.addEventListener('change', refreshPreview);
  appNo.addEventListener('input', () => { refreshPreview(); syncTitle(); });
  startDate.addEventListener('change', syncTitle);
  startDate.addEventListener('input', syncTitle);

  const err = el('div', { class: 'qam-sched-err', hidden: true });
  const body = el('div', {}, [
    el('div', { class: 'qam-insp-sec-note' }, [
      'AssetGroup（とドメイン）を作成し、続けて検査スケジュールを登録します。検査は検査予定日に1回だけ実行されます。作成後の変更・削除は Qualys の画面で行ってください。',
    ]),
    field('登録モード', regMode, '「管理表のみ更新」は Qualys へ一切登録せず、QAM の検査一覧・四半期判定に予定として記録します。'),

    section('申請情報'),
    field('外部接続申請番号', appNo, 'AssetGroup 名は「申請番号(仮)」、ドメイン名は「小文字の申請番号.地域コード」になります。'),
    field('件名', subject),
    field('申請部門', department, 'AssetGroup の Division に記録されます。'),
    rowRegion,
    field('申請者', applicant, '既定は記入者名です。'),

    section('検査対象'),
    field('資産種別', assetType, '静的=IP 資産（SCAN/MAP を選択可）。動的=FQDN 指定（SCAN のみ・IP は登録しません）。'),
    rowKind,
    rowIp,
    rowFqdn,
    field('作成される内容', preview),

    section('検査スケジュール'),
    field('検査予定日', startDate, 'この日に1回だけ実行されます（繰り返しはありません）。'),
    field('開始時刻（時／分）', el('div', { class: 'qam-sched-time' }, [startHour, startMinute])),
    field('スケジュールのタイトル', title, '既定は「AssetGroup名_検査予定日(YYYYMMDD)」。書き換えるとその値を使います。'),

    section('その他'),
    field('備考欄', note, '件名・申請者・備考は AssetGroup の Comments に記録されます。'),

    optSection,
    rowState,
    err,
  ]);
  const init = o.initial;
  if (init) {
    appNo.value = init.applicationNo;
    subject.value = init.subject ?? '';
    department.value = init.department ?? '';
    applicant.value = init.applicant?.trim() || o.author;
    note.value = init.note ?? '';
    assetType.value = init.assetType;
    kind.value = init.kind;
    if ([...region.options].some((op) => op.value === init.regionCode)) region.value = init.regionCode;
    for (const row of init.ips) addIp(row);
    for (const d of init.dnsNames) addFqdn(d);
  }
  if (!ipRows.length) addIp();
  if (!fqdnRows.length) addFqdn();
  syncRows();

  // 共通のスケジュール項目を組み立て、種別ごとに対象とプロファイルだけ差し替える。
  // タイムゾーンは共通設定の既定値を使う（画面では設定しない）。
  const readSchedule = (k: 'scan' | 'map', p: ProvisionInput): ScheduleInput => {
    const plan = planProvision(p);
    return {
      ...defaultScheduleInput(k, startDate.value),
      title: title.value.trim() || titleAuto,
      active: active.value === 'yes',
      targets: k === 'scan' ? [plan.title] : [plan.domain],
      optionProfile: k === 'scan' ? scanOpt.value : mapOpt.value,
      scannerName: scanner.value,
      startDate: startDate.value,
      startHour: Number(startHour.value), startMinute: Number(startMinute.value),
      timeZoneCode: o.defaults.timeZoneCode,
      observeDst: false,
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
    const mode = regMode.value as RegisterMode;
    const time = `${String(scan.startHour).padStart(2, '0')}:${String(scan.startMinute).padStart(2, '0')}`;
    const lines = mode === 'ledger'
      ? [
        '【管理表のみ更新】Qualys へは登録しません。',
        ...(plan.withScan ? [`SCAN 予定を記録: ${plan.title}（${scan.startDate} ${time}）`] : []),
        ...(plan.withMap ? [`MAP 予定を記録: ${plan.domain}（${scan.startDate} ${time}）`] : []),
      ]
      : describeProvision(p);
    if (!(await o.confirm(mode === 'ledger' ? '管理表に記録しますか？' : 'この内容で登録しますか？', lines))) return false;
    try {
      await o.submit(mode, p, scan, map);
      o.onDone();
      return true;
    } catch (e) {
      showErrors([(e as Error).message]);
      return false;
    }
  };

  return { node: body, submit };
}
