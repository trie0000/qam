// 簡易検査（検査登録）フォーム。1 回の登録で次を作る（資産種別・検査種別で増減する）:
//   AssetGroup「申請番号(仮)」作成 → （MAP のとき）ドメイン登録 → SCAN/MAP スケジュール登録
// 検査は「検査予定日に1回だけ」実行する運用のため、繰り返し（周期）の設定は持たない。
// 左ペインの独立ビューにインラインで置くので、本体（node）と送信処理（submit）を返す。
// 本番 Qualys への書き込みなので、送信前に「何が作られるか」を必ず確認させる。
// 命名・パラメータ組立・検証は provision.ts / schedule.ts（純粋関数）に委ねる。
import { el } from '../dom';
import { defaultScheduleInput, validateSchedule, type ScheduleInput } from '../../schedule';
import { assetEditor, type ResolveEntry } from './asset-editor';
import { emptyRegistry, existingNameLines, type AssetCheck, type AssetRegistry } from '../../precheck';
import {
  DEFAULT_REGIONS, planProvision, validateProvision, describeProvision,
  parseIpInput, parseFqdnInput, IP_INPUT_HINT, FQDN_INPUT_HINT,
  scheduleTitle,
  type AssetType, type ProvisionInput, type RegionOption,
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
  registry?: AssetRegistry; // 取り込み済みの AssetGroup/ドメイン/host list（事前チェック用）
  confirm: (title: string, lines: string[]) => Promise<boolean>;
  warn: (title: string, lines: string[]) => void;   // 書式違反の警告
  // トラッキング方式の食い違い確認（「検査担当に確認済み」を取れたら true）。
  confirmTracking: (issues: AssetCheck[]) => Promise<boolean>;
  // FQDN の名前解決（relay 経由）。未指定なら検証ボタンを出さない。
  resolveHosts?: (names: string[]) => Promise<{ name: string; ok: boolean; addresses: string[]; error?: string }[]>;
  // 名前解決が未検証／NG のまま登録しようとしたときの確認。続行なら true。
  confirmResolve: (rows: ResolveEntry[]) => Promise<boolean>;
  submit: (mode: RegisterMode, p: ProvisionInput, scan: ScheduleInput, map: ScheduleInput) => Promise<ProvisionResult>;
  onDone: () => void;
}

// セクション見出し（申請情報 / 検査対象 / 検査スケジュール / その他）。
const section = (title: string): HTMLElement => el('div', { class: 'qam-form-sec' }, [title]);

// 複数の field を 1 行に並べる（狭い画面では自動で縦積みになる）。
const pair = (a: HTMLElement, b: HTMLElement): HTMLElement => el('div', { class: 'qam-form-pair' }, [a, b]);
const triple = (a: HTMLElement, b: HTMLElement, c: HTMLElement): HTMLElement =>
  el('div', { class: 'qam-form-pair qam-form-pair--3' }, [a, b, c]);

const field = (label: string, node: Node, note = ''): HTMLElement =>
  el('div', { class: 'qam-field' }, [
    el('label', {}, [label]),
    node,
    ...(note ? [el('span', { class: 'qam-insp-sec-note' }, [note])] : []),
  ]);

const numInput = (value: number, min: number, max: number): HTMLInputElement =>
  el('input', { class: 'in', type: 'number', min: String(min), max: String(max), value: String(value) }) as HTMLInputElement;

// 日付＋時刻を 1 行に並べる（時・分は単位付きの小さな枠）。
const dateTimeRow = (date: HTMLElement, hour: HTMLElement, minute: HTMLElement): HTMLElement =>
  el('div', { class: 'qam-sched-dt' }, [
    date,
    el('div', { class: 'qam-sched-time' }, [
      hour, el('span', { class: 'qam-sched-unit' }, ['時']),
      minute, el('span', { class: 'qam-sched-unit' }, ['分']),
    ]),
  ]);

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
  const applicant = el('input', { class: 'in', placeholder: '例: 担当者名' }) as HTMLInputElement;
  const note = el('textarea', { class: 'in qam-prov-note', rows: '3', placeholder: '補足があれば記入' }) as HTMLTextAreaElement;
  const region = el('select', { class: 'in' }) as HTMLSelectElement;
  // 既定は未選択。MAP を実施する場合のみ必須（ドメイン名の末尾に使う）。
  region.append(el('option', { value: '' }, ['（未選択）']));
  regions.forEach((r) => region.append(el('option', { value: r.code }, [`${r.label}（${r.code}）`])));
  const preview = el('div', { class: 'qam-prov-preview' });
  // 取り込み済みデータに同名の AssetGroup / ドメインがあるときの注意（赤字）。
  const exists = el('div', { class: 'qam-prov-exists', hidden: true });
  const warnInvalid = (kind: string) => (bad: string[]): void => {
    o.warn(`${kind}の書式を確認してください`, [
      `次の入力は書式に合っていません: ${bad.join(', ')}`,
      kind === 'IP' ? `正しい書式: ${IP_INPUT_HINT}` : `正しい書式: ${FQDN_INPUT_HINT}`,
    ]);
  };
  // 取り込み済みデータ（AssetGroup/ドメイン/host list）。未取込なら「判定不可」表示になる。
  const registry = o.registry ?? emptyRegistry();
  const ipEditor = assetEditor({
    hint: IP_INPUT_HINT, assetType: 'static', registry, mapAllowed: true,
    parse: parseIpInput, onInvalid: warnInvalid('IP'), onChange: () => refreshAll(),
  });
  const fqdnEditor = assetEditor({
    hint: FQDN_INPUT_HINT, assetType: 'dynamic', registry, mapAllowed: false, // 動的は MAP 対象外
    parse: parseFqdnInput, onInvalid: warnInvalid('FQDN'), onChange: () => refreshAll(),
    resolve: o.resolveHosts,
    onError: (m) => o.warn('名前解決に失敗しました', [m, 'relay が起動しているか、名前解決できるネットワークかを確認してください。']),
  });

  // ---- スケジュール（1回のみ: 検査予定日と開始時刻だけ）----
  const active = el('select', { class: 'in' }) as HTMLSelectElement;
  active.append(el('option', { value: 'no' }, ['無効で作成（Qualys で確認してから有効化）']), el('option', { value: 'yes' }, ['有効で作成（検査予定日に実行される）']));
  const scanOpt = el('input', { class: 'in', value: o.defaults.scanOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const mapOpt = el('input', { class: 'in', value: o.defaults.mapOptionProfile, placeholder: '未入力ならアカウント既定' }) as HTMLInputElement;
  const scanner = el('input', { class: 'in', value: o.defaults.scannerAppliance }) as HTMLInputElement;
  // 検査予定日時は MAP / SCAN で別に持つ。「同じタイミング」にすると SCAN は MAP の値に追従する
  // （表示順が MAP → SCAN なので、先に入力する MAP を基準にする）。
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
  const rowApplicant = field('申請部門担当者', applicant, '検査を依頼してきた部門の担当者名（ツールの利用者ではありません）。');
  const rowRegion = field('地域区分', region, 'MAP 用ドメイン名の末尾に付きます。MAP を実施する場合は必須。');
  const rowIp = field('検査資産情報（IP）', ipEditor.node,
    '入力して「追加」（Ctrl/⌘+Enter でも可）。カンマ区切り・改行区切りで複数まとめて追加できます。'
    + '行ごとに MAP / SCAN を選べます（両方可）。プライベートIP（10/8・172.16/12・192.168/16）は登録できません。');
  const rowFqdn = field('検査資産情報（FQDN）', fqdnEditor.node,
    '入力して「追加」（Ctrl/⌘+Enter でも可）。カンマ区切り・改行区切りで複数まとめて追加できます。'
    + '動的（FQDN 指定）は MAP 検査の対象外のため、MAP は選べません（SCAN のみ）。'
    + '「名前解決を検証」で DNS を引いて確認できます（未検証・解決できないまま登録すると警告します）。');

  const rowMapTime = field('MAP の検査予定日時', dateTimeRow(mapDate, mapHour, mapMinute), 'この日時に1回だけ実行されます。');
  const rowScanTime = field('SCAN の検査予定日時', dateTimeRow(scanDate, scanHour, scanMinute), 'この日時に1回だけ実行されます。');
  const rowMapTitle = field('MAP のスケジュールタイトル', mapTitle, '既定は「AssetGroup名_m_検査予定日」。');
  const rowScanTitle = field('SCAN のスケジュールタイトル', scanTitle, '既定は「AssetGroup名_s_検査予定日」。');

  // 既定値は共通設定から来る。何が入るのかを具体値で示す（未設定なら Qualys 側の既定に委ねる旨）。
  const defNote = (v: string): string =>
    (v.trim() ? `共通設定の既定値: ${v.trim()}` : '共通設定が未設定のため、Qualys アカウントの既定プロファイルが適用されます。');
  const rowMapOpt = field('MAP のオプションプロファイル', mapOpt, defNote(o.defaults.mapOptionProfile));
  const rowScanOpt = field('SCAN のオプションプロファイル', scanOpt, defNote(o.defaults.scanOptionProfile));
  const rowScanner = field('スキャナー', scanner, `共通設定の既定値: ${o.defaults.scannerAppliance || 'External'}`);
  // 通常は触らない項目なのでトグルで畳んでおく（開いた状態は保持しない＝毎回閉じる）。
  const optBody = el('div', { class: 'qam-prov-optbody', hidden: true }, [rowScanner, rowMapOpt, rowScanOpt]);
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

  // 「同じタイミング」なら SCAN の日時は MAP に追従する（先に入力する MAP が基準）。
  // 片方しか実施しないときは同期しない（未使用側の値で上書きしてしまうため）。
  const syncTiming = (): void => {
    const p = planProvision(readProvision());
    if (!sameTiming.checked || !p.withMap || !p.withScan) return;
    scanDate.value = mapDate.value;
    scanHour.value = mapHour.value;
    scanMinute.value = mapMinute.value;
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
  // 取り込み済みデータに同名があれば「新規作成ではなく更新になる」ことを赤字で添える。
  function refreshPreview(): void {
    const p = planProvision(readProvision());
    const rows: string[] = [`AssetGroup: ${p.title || '（申請番号を入力）'}`];
    rows.push(`MAP 対象: ${p.mapTargets.length ? p.mapTargets.join(', ') : '（なし）'}`);
    if (p.domains.length) rows.push(`ドメイン: ${p.domains.join(', ')}`);
    rows.push(`SCAN 対象: ${p.scanTargets.length ? p.scanTargets.join(', ') : '（なし）'}`);
    preview.textContent = rows.join('　/　');
    const lines = p.title ? existingNameLines(registry, p.title, p.domains) : [];
    exists.hidden = !lines.length;
    exists.textContent = lines.join('\n');
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
    // 地域区分は常に表示する（MAP を選んだときだけ必須）。MAP 側の設定は MAP 対象があるときだけ。
    show(rowMapTime, p.withMap);
    show(rowMapTitle, p.withMap);
    show(rowScanTime, p.withScan && !(p.withMap && sameTiming.checked));
    show(rowScanTitle, p.withScan);
    show(rowSameTiming, p.withScan && p.withMap);
    show(optSection, !isLedger);
    show(rowState, !isLedger);
    show(rowMapOpt, p.withMap);
    show(rowScanOpt, p.withScan);
    syncTiming();
    refreshPreview();
    syncTitles();
  }
  const rowSameTiming = el('label', { class: 'qam-prov-opttoggle' }, [
    sameTiming, el('span', {}, ['MAP と SCAN を同じタイミングで実施する']),
  ]);
  sameTiming.addEventListener('change', refreshAll);
  regMode.addEventListener('change', refreshAll);
  assetType.addEventListener('change', refreshAll);
  region.addEventListener('change', refreshAll);
  appNo.addEventListener('input', refreshAll);
  for (const inp of [mapDate, mapHour, mapMinute]) inp.addEventListener('input', refreshAll);
  for (const inp of [scanDate, scanHour, scanMinute]) inp.addEventListener('input', () => { refreshPreview(); syncTitles(); });

  const err = el('div', { class: 'qam-sched-err', hidden: true });
  const body = el('div', {}, [
    el('div', { class: 'qam-insp-sec-note' }, [
      'AssetGroup（とドメイン）を作成し、続けて検査スケジュールを登録します。検査は検査予定日に1回だけ実行されます。作成後の変更・削除は Qualys の画面で行ってください。',
    ]),
    field('登録モード', regMode, '「管理表のみ更新」は Qualys へ一切登録せず、QAM の検査一覧・四半期判定に予定として記録します。'),

    section('申請情報'),
    pair(
      field('外部接続申請番号', appNo, 'AssetGroup 名は「申請番号(仮)」になります。'),
      field('件名', subject),
    ),
    triple(rowDepartment, rowApplicant, rowRegion),

    section('検査対象'),
    rowAssetType,
    rowIp,
    rowFqdn,
    field('作成される内容', el('div', {}, [preview, exists])),

    section('検査スケジュール'),
    rowSameTiming,
    pair(rowMapTime, rowScanTime),
    pair(rowMapTitle, rowScanTitle),

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
    // スケジュール側の検証は入力（AssetGroup/ドメイン）が揃ってから。先に出すと
    // 「地域区分が未選択」→「対象のドメインを入力してください」のように、原因ではない
    // 派生エラーが並んで分かりにくくなる。
    const invalid = validateProvision(p);
    const errors = invalid.length ? invalid : [
      ...(plan.withScan ? validateSchedule(scan) : []),
      ...(plan.withMap ? validateSchedule(map) : []),
    ];
    if (errors.length) { showErrors([...new Set(errors)]); return false; }
    showErrors([]);
    // 既存ホストとトラッキング方式が食い違う資産があれば、検査担当の確認が取れるまで進めない。
    const editor = assetType.value === 'dynamic' ? fqdnEditor : ipEditor;
    const conflicts = editor.conflicts();
    if (conflicts.length && !(await o.confirmTracking(conflicts))) return false;
    // 名前解決が未検証／NG の FQDN があれば、そのまま登録してよいか確認する。
    const unresolved = editor.unresolved();
    if (unresolved.length && !(await o.confirmResolve(unresolved))) return false;
    const mode = regMode.value as RegisterMode;
    const at = (i: ScheduleInput): string =>
      `${i.startDate} ${String(i.startHour).padStart(2, '0')}:${String(i.startMinute).padStart(2, '0')}`;
    const lines = mode === 'ledger'
      ? [
        '【管理表のみ更新】Qualys へは登録しません。',
        ...(plan.withScan ? [`SCAN 予定を記録: ${plan.title}（${at(scan)}）`] : []),
        ...(plan.withMap ? [`MAP 予定を記録: ${plan.domains.join(', ')}（${at(map)}）`] : []),
      ]
      // 同名が取り込み済みなら「作成」ではなく「更新」になる旨も確認画面に出す。
      : [...describeProvision(p), ...existingNameLines(registry, plan.title, plan.domains)];
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
