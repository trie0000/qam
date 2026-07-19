// 簡易検査（検査登録）フォーム。1 回の登録で次を作る（資産種別・検査種別で増減する）:
//   AssetGroup「申請番号(仮)」作成 → （MAP のとき）ドメイン登録 → SCAN/MAP スケジュール登録
// 検査は「検査予定日に1回だけ」実行する運用のため、繰り返し（周期）の設定は持たない。
// 左ペインの独立ビューにインラインで置くので、本体（node）と送信処理（submit）を返す。
// 本番 Qualys への書き込みなので、送信前に「何が作られるか」を必ず確認させる。
// 命名・パラメータ組立・検証は provision.ts / schedule.ts（純粋関数）に委ねる。
import { el, clear } from '../dom';
import { icon } from '../../icons';
import { defaultScheduleInput, validateSchedule, type ScheduleInput } from '../../schedule';
import {
  DEFAULT_REGIONS, planProvision, validateProvision, describeProvision,
  parseIpInput, parseFqdnInput, IP_INPUT_HINT, FQDN_INPUT_HINT,
  scheduleTitle,
  type AssetEntry, type AssetType, type ProvisionInput, type RegionOption, type TokenParse,
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
  warn: (title: string, lines: string[]) => void;   // 書式違反の警告
  submit: (mode: RegisterMode, p: ProvisionInput, scan: ScheduleInput, map: ScheduleInput) => Promise<ProvisionResult>;
  onDone: () => void;
}

// セクション見出し（申請情報 / 検査対象 / 検査スケジュール / その他）。
const section = (title: string): HTMLElement => el('div', { class: 'qam-form-sec' }, [title]);

// 2 つの field を 1 行に並べる（狭い画面では自動で縦積みになる）。
const pair = (a: HTMLElement, b: HTMLElement): HTMLElement => el('div', { class: 'qam-form-pair' }, [a, b]);

const field = (label: string, node: Node, note = ''): HTMLElement =>
  el('div', { class: 'qam-field' }, [
    el('label', {}, [label]),
    node,
    ...(note ? [el('span', { class: 'qam-insp-sec-note' }, [note])] : []),
  ]);

const numInput = (value: number, min: number, max: number): HTMLInputElement =>
  el('input', { class: 'in', type: 'number', min: String(min), max: String(max), value: String(value) }) as HTMLInputElement;

// 検査資産情報のエディタ: テキスト欄に直接入力 →「追加」でリストへ。
// 行ごとに SCAN / MAP のチェックを持ち（両方可）、ヘッダのチェックで全選択/全解除できる。
// カンマ・改行区切りは分割して複数行として登録する（レンジは展開しない）。
// 書式違反が1つでもあれば何も追加せず警告し、入力はそのまま残して修正を促す。
interface AssetEditor {
  node: HTMLElement;
  read: () => AssetEntry[];
  add: (entries: AssetEntry[]) => void;
  setEnabled: (on: boolean) => void;
}
function assetEditor(
  hint: string,
  parse: (raw: string) => TokenParse,
  onInvalid: (bad: string[]) => void,
  onChange: () => void,
): AssetEditor {
  const rows: AssetEntry[] = [];
  const input = el('textarea', { class: 'in qam-tok-ta', rows: '3', placeholder: hint }) as HTMLTextAreaElement;
  const addBtn = el('button', { class: 'btn btn--sm', type: 'button' }, ['追加']);
  const list = el('div', { class: 'qam-tok-list' });
  const allScan = el('input', { type: 'checkbox', title: 'すべての資産を SCAN 対象にする' }) as HTMLInputElement;
  const allMap = el('input', { type: 'checkbox', title: 'すべての資産を MAP 対象にする' }) as HTMLInputElement;
  const head = el('div', { class: 'qam-tok-head', hidden: true }, [
    el('span', { class: 'qam-tok-headlbl' }, ['すべて']),
    el('label', { class: 'qam-tok-ck' }, [allScan, el('span', {}, ['SCAN'])]),
    el('label', { class: 'qam-tok-ck' }, [allMap, el('span', {}, ['MAP'])]),
  ]);

  // ヘッダのチェック状態を行の状態に合わせる（全部入っていれば on）。
  const syncHead = (): void => {
    head.hidden = rows.length === 0;
    allScan.checked = rows.length > 0 && rows.every((r) => r.scan);
    allMap.checked = rows.length > 0 && rows.every((r) => r.map);
  };
  const draw = (): void => {
    clear(list);
    rows.forEach((r, idx) => {
      const del = el('button', { class: 'btn btn--icon btn--sm', type: 'button', 'aria-label': `${r.value} を削除`, title: '削除', html: icon('x', 13) });
      del.addEventListener('click', () => { rows.splice(idx, 1); draw(); onChange(); });
      const ck = (kind: 'scan' | 'map'): HTMLElement => {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = r[kind];
        cb.addEventListener('change', () => { r[kind] = cb.checked; syncHead(); onChange(); });
        return el('label', { class: 'qam-tok-ck' }, [cb, el('span', {}, [kind === 'scan' ? 'SCAN' : 'MAP'])]);
      };
      list.append(el('div', { class: 'qam-tok-item' }, [
        del, el('span', { class: 'qam-tok-val' }, [r.value]), el('span', { class: 'qam-spacer' }), ck('scan'), ck('map'),
      ]));
    });
    syncHead();
    onChange();
  };
  const setAll = (kind: 'scan' | 'map', on: boolean): void => {
    for (const r of rows) r[kind] = on;
    draw();
  };
  allScan.addEventListener('change', () => setAll('scan', allScan.checked));
  allMap.addEventListener('change', () => setAll('map', allMap.checked));

  const commit = (): void => {
    const { tokens, errors } = parse(input.value);
    if (errors.length) { onInvalid(errors); return; } // 修正できるよう入力は消さない
    // 新規行は既定で SCAN 対象（大半が SCAN のため）。MAP は明示的に選ばせる。
    for (const t of tokens) if (!rows.some((r) => r.value === t)) rows.push({ value: t, scan: true, map: false });
    input.value = '';
    draw();
  };
  addBtn.addEventListener('click', commit);
  // Ctrl/Cmd+Enter で追加（素の Enter は改行として使う）。IME 変換中は無視する。
  input.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });

  const node = el('div', {}, [el('div', { class: 'qam-tok-input' }, [input, addBtn]), head, list]);
  return {
    node,
    read: () => rows.map((r) => ({ ...r })),
    add: (init) => { for (const a of init) if (a.value && !rows.some((r) => r.value === a.value)) rows.push({ ...a }); draw(); },
    // 資産種別で使わない側は入力自体を止める（見えていても打てない状態にしない）。
    setEnabled: (on) => {
      input.disabled = !on;
      addBtn.toggleAttribute('disabled', !on);
      if (!on) { rows.length = 0; input.value = ''; draw(); } // 使わない入力は残さない
    },
  };
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
    el('option', { value: 'static' }, ['静的（IP 指定）']),
    el('option', { value: 'dynamic' }, ['動的（FQDN 指定）']),
  );
  const appNo = el('input', { class: 'in', placeholder: '例: EXT-2026-001' }) as HTMLInputElement;
  const subject = el('input', { class: 'in', placeholder: '例: ○○システム 外部公開に伴う検査' }) as HTMLInputElement;
  const department = el('input', { class: 'in', placeholder: '例: ○○部' }) as HTMLInputElement;
  const applicant = el('input', { class: 'in', placeholder: '検査を依頼してきた部門の担当者名' }) as HTMLInputElement;
  const note = el('textarea', { class: 'in qam-prov-note', rows: '3', placeholder: '補足があれば記入' }) as HTMLTextAreaElement;
  const region = el('select', { class: 'in' }) as HTMLSelectElement;
  regions.forEach((r) => region.append(el('option', { value: r.code }, [`${r.label}（${r.code}）`])));
  const preview = el('div', { class: 'qam-prov-preview' });
  const warnInvalid = (kind: string) => (bad: string[]): void => {
    o.warn(`${kind}の書式を確認してください`, [
      `次の入力は書式に合っていません: ${bad.join(', ')}`,
      kind === 'IP' ? `正しい書式: ${IP_INPUT_HINT}` : `正しい書式: ${FQDN_INPUT_HINT}`,
    ]);
  };
  const ipEditor = assetEditor(IP_INPUT_HINT, parseIpInput, warnInvalid('IP'), () => refreshAll());
  const fqdnEditor = assetEditor(FQDN_INPUT_HINT, parseFqdnInput, warnInvalid('FQDN'), () => refreshAll());

  // ---- スケジュール（1回のみ: 検査予定日と開始時刻だけ）----
  const title = el('input', { class: 'in', placeholder: 'AssetGroup名_YYYYMMDD が自動で入ります' }) as HTMLInputElement;
  const active = el('select', { class: 'in' }) as HTMLSelectElement;
  active.append(el('option', { value: 'no' }, ['無効で作成（Qualys で確認してから有効化）']), el('option', { value: 'yes' }, ['有効で作成（検査予定日に実行される）']));
  const scanOpt = el('input', { class: 'in', value: o.defaults.scanOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const mapOpt = el('input', { class: 'in', value: o.defaults.mapOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const scanner = el('input', { class: 'in', value: o.defaults.scannerAppliance }) as HTMLInputElement;
  // 検査予定日時は SCAN / MAP で別に持つ。「同じタイミング」にすると MAP は SCAN の値に追従する。
  const sameTiming = el('input', { type: 'checkbox' }) as HTMLInputElement;
  sameTiming.checked = true;
  const scanDate = el('input', { class: 'in', type: 'date', value: o.today }) as HTMLInputElement;
  const scanHour = numInput(2, 0, 23);
  const scanMinute = numInput(0, 0, 59);
  const mapDate = el('input', { class: 'in', type: 'date', value: o.today }) as HTMLInputElement;
  const mapHour = numInput(2, 0, 23);
  const mapMinute = numInput(0, 0, 59);
  const scanTitle = el('input', { class: 'in', placeholder: 'AssetGroup名_s_YYYYMMDD が自動で入ります' }) as HTMLInputElement;
  const mapTitle = el('input', { class: 'in', placeholder: 'AssetGroup名_m_YYYYMMDD が自動で入ります' }) as HTMLInputElement;

  const rowAssetType = field('資産種別', assetType, '静的=IP 指定。動的=FQDN 指定（IP は入力できません）。');
  const rowDepartment = field('申請部門', department, 'AssetGroup の Division に記録されます。');
  const rowApplicant = field('申請部門担当者', applicant, '検査を依頼してきた部門の担当者名です（このツールの利用者ではありません）。');
  const rowRegion = field('地域区分', region, 'MAP 用ドメイン名の末尾に付く地域コードです。');
  const rowIp = field('検査資産情報（IP）', ipEditor.node,
    '入力して「追加」（Ctrl/⌘+Enter でも可）。カンマ区切り・改行区切りで複数まとめて追加できます。'
    + '行ごとに SCAN / MAP を選べます（両方可）。プライベートIP（10/8・172.16/12・192.168/16）は登録できません。');
  const rowFqdn = field('検査資産情報（FQDN）', fqdnEditor.node,
    '入力して「追加」（Ctrl/⌘+Enter でも可）。カンマ区切り・改行区切りで複数まとめて追加できます。'
    + '行ごとに SCAN / MAP を選べます（両方可）。');

  const rowScanTime = field('SCAN の検査予定日時',
    el('div', { class: 'qam-sched-dt' }, [scanDate, el('div', { class: 'qam-sched-time' }, [scanHour, scanMinute])]),
    'この日時に1回だけ実行されます。');
  const rowMapTime = field('MAP の検査予定日時',
    el('div', { class: 'qam-sched-dt' }, [mapDate, el('div', { class: 'qam-sched-time' }, [mapHour, mapMinute])]));
  const rowScanTitle = field('SCAN のスケジュールタイトル', scanTitle, '既定は「AssetGroup名_s_検査予定日」。');
  const rowMapTitle = field('MAP のスケジュールタイトル', mapTitle, '既定は「AssetGroup名_m_検査予定日」。');

  // 既定値は共通設定から来る。何が入るのかを具体値で示す（未設定なら Qualys 側の既定に委ねる旨）。
  const defNote = (v: string): string =>
    (v.trim() ? `共通設定の既定値: ${v.trim()}` : '共通設定が未設定のため、Qualys アカウントの既定プロファイルが適用されます。');
  const rowScanOpt = field('SCAN のオプションプロファイル', scanOpt, defNote(o.defaults.scanOptionProfile));
  const rowMapOpt = field('MAP のオプションプロファイル', mapOpt, defNote(o.defaults.mapOptionProfile));
  const rowScanner = field('スキャナー', scanner, `共通設定の既定値: ${o.defaults.scannerAppliance || 'External'}`);
  // 通常は触らない項目なのでトグルで畳んでおく（開いた状態は保持しない＝毎回閉じる）。
  const optBody = el('div', { class: 'qam-prov-optbody', hidden: true }, [rowScanner, rowScanOpt, rowMapOpt]);
  const optCb = el('input', { type: 'checkbox', id: 'qam-opt-toggle' }) as HTMLInputElement;
  optCb.addEventListener('change', () => { optBody.hidden = !optCb.checked; });
  const optToggle = el('label', { class: 'qam-prov-opttoggle', for: 'qam-opt-toggle' }, [
    optCb, el('span', {}, ['オプション設定（スキャナー・オプションプロファイル）']),
  ]);
  const optSection = el('div', { class: 'qam-prov-opt' }, [optToggle, optBody]);
  const rowState = field('作成時の状態', active);

  const readProvision = (): ProvisionInput => ({
    applicationNo: appNo.value,
    regionCode: region.value,
    assetType: assetType.value as AssetType,
    assets: (assetType.value === 'dynamic' ? fqdnEditor : ipEditor).read(),
    subject: subject.value,
    department: department.value,
    applicant: applicant.value,
    note: note.value,
  });

  // 「同じタイミング」なら MAP の日時は SCAN に追従する。
  const syncTiming = (): void => {
    if (!sameTiming.checked) return;
    mapDate.value = scanDate.value;
    mapHour.value = scanHour.value;
    mapMinute.value = scanMinute.value;
  };

  // スケジュールタイトルの既定値: AssetGroup 名 + _s_/_m_ + 検査予定日(YYYYMMDD)。
  // 申請番号・予定日に追従するが、利用者が手で書き換えた値は上書きしない。
  let scanAuto = '';
  let mapAuto = '';
  const syncTitles = (): void => {
    const plan = planProvision(readProvision());
    const nextScan = plan.title && ymd(scanDate.value) ? scheduleTitle(plan.title, 'scan', ymd(scanDate.value)) : '';
    const nextMap = plan.title && ymd(mapDate.value) ? scheduleTitle(plan.title, 'map', ymd(mapDate.value)) : '';
    if (scanTitle.value === scanAuto) scanTitle.value = nextScan;
    if (mapTitle.value === mapAuto) mapTitle.value = nextMap;
    scanAuto = nextScan;
    mapAuto = nextMap;
  };

  // 作られるものを常に見せる（送信して初めて分かる、を避ける）。
  function refreshPreview(): void {
    const p = planProvision(readProvision());
    const rows: string[] = [`AssetGroup: ${p.title || '（申請番号を入力）'}`];
    rows.push(`SCAN 対象: ${p.scanTargets.length ? p.scanTargets.join(', ') : '（なし）'}`);
    rows.push(`MAP 対象: ${p.mapTargets.length ? p.mapTargets.join(', ') : '（なし）'}`);
    if (p.domains.length) rows.push(`ドメイン: ${p.domains.join(', ')}`);
    preview.textContent = rows.join('　/　');
  }

  const show = (node: HTMLElement, on: boolean): void => { node.hidden = !on; };
  function refreshAll(): void {
    const isDyn = assetType.value === 'dynamic';
    const p = planProvision(readProvision());
    const isLedger = regMode.value === 'ledger';
    show(rowIp, !isDyn);
    show(rowFqdn, isDyn);
    ipEditor.setEnabled(!isDyn);
    fqdnEditor.setEnabled(isDyn);
    // MAP を実施する資産があるときだけ、地域区分と MAP 側の設定を出す。
    show(rowRegion, p.withMap && !isDyn);
    show(rowScanTime, p.withScan);
    show(rowScanTitle, p.withScan);
    show(rowMapTime, p.withMap && !sameTiming.checked);
    show(rowMapTitle, p.withMap);
    show(rowSameTiming, p.withScan && p.withMap);
    show(optSection, !isLedger);
    show(rowState, !isLedger);
    show(rowScanOpt, p.withScan);
    show(rowMapOpt, p.withMap);
    syncTiming();
    refreshPreview();
    syncTitles();
  }
  const rowSameTiming = el('label', { class: 'qam-prov-opttoggle' }, [
    sameTiming, el('span', {}, ['SCAN と MAP を同じタイミングで実施する']),
  ]);
  sameTiming.addEventListener('change', refreshAll);
  regMode.addEventListener('change', refreshAll);
  assetType.addEventListener('change', refreshAll);
  region.addEventListener('change', refreshAll);
  appNo.addEventListener('input', refreshAll);
  for (const inp of [scanDate, scanHour, scanMinute]) inp.addEventListener('input', refreshAll);
  for (const inp of [mapDate, mapHour, mapMinute]) inp.addEventListener('input', () => { refreshPreview(); syncTitles(); });

  const err = el('div', { class: 'qam-sched-err', hidden: true });
  const body = el('div', {}, [
    el('div', { class: 'qam-insp-sec-note' }, [
      'AssetGroup（とドメイン）を作成し、続けて検査スケジュールを登録します。検査は検査予定日に1回だけ実行されます。作成後の変更・削除は Qualys の画面で行ってください。',
    ]),
    field('登録モード', regMode, '「管理表のみ更新」は Qualys へ一切登録せず、QAM の検査一覧・四半期判定に予定として記録します。'),

    section('申請情報'),
    field('外部接続申請番号', appNo, 'AssetGroup 名は「申請番号(仮)」になります。'),
    field('件名', subject),
    pair(rowDepartment, rowApplicant),
    rowRegion,

    section('検査対象'),
    rowAssetType,
    rowIp,
    rowFqdn,
    field('作成される内容', preview),

    section('検査スケジュール'),
    rowSameTiming,
    pair(rowScanTime, rowMapTime),
    pair(rowScanTitle, rowMapTitle),

    section('その他'),
    field('備考欄', note, '件名・申請部門担当者・備考は AssetGroup の Comments に記録されます。'),

    optSection,
    rowState,
    err,
  ]);

  const init = o.initial;
  if (init) {
    appNo.value = init.applicationNo;
    subject.value = init.subject ?? '';
    department.value = init.department ?? '';
    applicant.value = init.applicant ?? '';
    note.value = init.note ?? '';
    assetType.value = init.assetType;
    if ([...region.options].some((op) => op.value === init.regionCode)) region.value = init.regionCode;
  }
  refreshAll(); // 先に資産種別を反映（使わない側を無効化）してから値を入れる
  if (init) {
    (init.assetType === 'dynamic' ? fqdnEditor : ipEditor).add(init.assets);
    refreshAll();
  }

  // スケジュール入力を組み立てる。対象は種別ごとに差し替える。
  // タイムゾーンは共通設定の既定値を使う（画面では設定しない）。
  const readSchedule = (k: 'scan' | 'map', p: ProvisionInput): ScheduleInput => {
    const plan = planProvision(p);
    const isScan = k === 'scan';
    const date = isScan ? scanDate.value : mapDate.value;
    return {
      ...defaultScheduleInput(k, date),
      title: (isScan ? scanTitle.value.trim() || scanAuto : mapTitle.value.trim() || mapAuto),
      active: active.value === 'yes',
      targets: isScan ? [plan.title] : plan.domains,
      optionProfile: isScan ? scanOpt.value : mapOpt.value,
      scannerName: scanner.value,
      startDate: date,
      startHour: Number(isScan ? scanHour.value : mapHour.value),
      startMinute: Number(isScan ? scanMinute.value : mapMinute.value),
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
    const errors = [
      ...validateProvision(p),
      ...(plan.withScan ? validateSchedule(scan) : []),
      ...(plan.withMap ? validateSchedule(map) : []),
    ];
    if (errors.length) { showErrors([...new Set(errors)]); return false; }
    showErrors([]);
    const mode = regMode.value as RegisterMode;
    const at = (i: ScheduleInput): string =>
      `${i.startDate} ${String(i.startHour).padStart(2, '0')}:${String(i.startMinute).padStart(2, '0')}`;
    const lines = mode === 'ledger'
      ? [
        '【管理表のみ更新】Qualys へは登録しません。',
        ...(plan.withScan ? [`SCAN 予定を記録: ${plan.title}（${at(scan)}）`] : []),
        ...(plan.withMap ? [`MAP 予定を記録: ${plan.domains.join(', ')}（${at(map)}）`] : []),
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
