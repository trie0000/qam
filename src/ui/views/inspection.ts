// 四半期検査ビュー: 現四半期の SCAN/MAP 充足状況と週次の振り返り。
// 達成率カード → 週次サマリ → 対象×週マトリクス → 対象母集団 → 取得内訳 の順に縦へ積む。
// 一覧は共通テーブル(renderTable)を高さ未指定で置き、ページ全体でスクロールさせる
// （内部スクロールの入れ子を作らない）。診断系の小さな表だけ素の table を使う。
import { el } from '../dom';
import { icon } from '../../icons';
import { renderTable, type Column } from '../table';
import { exportCsv, exportXlsxBook, type Sheet } from '../../export';
import { countStatus, type InspectionData, type InspRow, type InspStatus, type MatrixRow, type WeekSummary } from '../../inspection';

const STATUS_LABEL: Record<InspStatus, string> = { done: '検査済み', scheduled: 'スケジュール済み', pending: '未対応' };
const STATUS_CLASS: Record<InspStatus, string> = { done: 'is-done', scheduled: 'is-sched', pending: 'is-pending' };

const fmtDate = (iso: string): string => (iso ? new Date(iso).toLocaleDateString('ja-JP') : '');
const kindLabel = (r: InspRow): string => (r.kind === 'scan' ? 'SCAN' : 'MAP');

// 見出し付きのセクション枠。
function section(title: string, note: string, body: HTMLElement): HTMLElement {
  return el('section', { class: 'qam-insp-sec' }, [
    el('h3', { class: 'qam-insp-sec-title' }, [title]),
    ...(note ? [el('p', { class: 'qam-insp-sec-note' }, [note])] : []),
    body,
  ]);
}

// 素の表（ヘッダ＋行）。行数が限られるダッシュボード用途なので仮想スクロールはしない。
function table(headers: string[], rows: (string | Node)[][], cls = ''): HTMLElement {
  const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', {}, [h])))]);
  const tbody = el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, [c])))));
  return el('div', { class: 'qam-insp-tablewrap' }, [el('table', { class: `qam-insp-table ${cls}`.trim() }, [thead, tbody])]);
}

// 済/予定/未対応 のカウントカード。
function statCard(title: string, rows: InspRow[]): HTMLElement {
  const c = countStatus(rows);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const item = (label: string, n: number, cls: string): HTMLElement =>
    el('div', { class: `qam-insp-stat ${cls}` }, [
      el('span', { class: 'qam-insp-stat-n' }, [String(n)]),
      el('span', { class: 'qam-insp-stat-k' }, [label]),
    ]);
  return el('div', { class: 'qam-insp-card' }, [
    el('div', { class: 'qam-insp-card-head' }, [
      el('span', { class: 'qam-insp-card-title' }, [title]),
      el('span', { class: 'qam-insp-card-pct' }, [`達成 ${pct}%（${c.done}/${c.total}）`]),
    ]),
    el('div', { class: 'qam-insp-statrow' }, [
      item('検査済み', c.done, 'is-done'),
      item('スケジュール済み', c.scheduled, 'is-sched'),
      item('未対応', c.pending, 'is-pending'),
    ]),
  ]);
}

// 共通テーブルで一覧を出す（列名クリックで並べ替え・値で絞り込み。他のビューと同じ操作）。
// 高さは固定せずページの流れに置く（内部スクロールの入れ子を作らない）。renderTable の
// height:100% は高さ未指定の親の下では auto に解決され、全行がそのまま並ぶ。
const selections = { weekly: new Set<string>(), matrix: new Set<string>() };
function commonTable(viewId: string, columns: Column[], rows: unknown[], getKey: (r: any) => string): HTMLElement {
  const selected = viewId.endsWith('weekly') ? selections.weekly : selections.matrix;
  const columnRef: { open?: (a: HTMLElement) => void } = {};
  const host = el('div', { class: 'qam-insp-tbl' }, [
    renderTable({ viewId, columns, rows, getKey, selected, columnRef }),
  ]);
  const colBtn = el('button', { class: 'btn btn--sm', title: '表示する列を選択', html: `${icon('settings', 14)}<span>列表示</span>` });
  colBtn.addEventListener('click', (e) => { e.stopPropagation(); columnRef.open?.(colBtn); });
  return el('div', { class: 'qam-insp-tblwrap' }, [el('div', { class: 'qam-insp-tblbar' }, [colBtn]), host]);
}

// 週次サマリ: 週ごとの 実施 / 予約 と、四半期開始からの累計（実施＋予約）。
function weeklySection(d: InspectionData): HTMLElement {
  const num = (v: number): string => String(v);
  const cols: Column[] = [
    { id: 'week', label: '週', mono: true, render: (w: WeekSummary) => `第${w.no}週`, sortVal: (w: WeekSummary) => String(w.no).padStart(3, '0') },
    { id: 'period', label: '期間', mono: true, render: (w: WeekSummary) => w.period },
    { id: 'scanDone', label: 'SCAN 実施', mono: true, render: (w: WeekSummary) => num(w.scanDone), sortVal: (w: WeekSummary) => String(w.scanDone).padStart(6, '0') },
    { id: 'scanSched', label: 'SCAN 予約', mono: true, render: (w: WeekSummary) => num(w.scanSched), sortVal: (w: WeekSummary) => String(w.scanSched).padStart(6, '0') },
    { id: 'scanCum', label: 'SCAN 累計', mono: true, render: (w: WeekSummary) => `${w.scanCum} / ${d.scan.length}`, sortVal: (w: WeekSummary) => String(w.scanCum).padStart(6, '0') },
    { id: 'mapDone', label: 'MAP 実施', mono: true, render: (w: WeekSummary) => num(w.mapDone), sortVal: (w: WeekSummary) => String(w.mapDone).padStart(6, '0') },
    { id: 'mapSched', label: 'MAP 予約', mono: true, render: (w: WeekSummary) => num(w.mapSched), sortVal: (w: WeekSummary) => String(w.mapSched).padStart(6, '0') },
    { id: 'mapCum', label: 'MAP 累計', mono: true, render: (w: WeekSummary) => `${w.mapCum} / ${d.map.length}`, sortVal: (w: WeekSummary) => String(w.mapCum).padStart(6, '0') },
  ];
  return section(
    '週次サマリ',
    '週ごとの実施件数・予約件数と、四半期開始からの累計（実施＋予約）。列名クリックで並べ替え・絞り込み。',
    commonTable('inspection.weekly', cols, d.weeks, (w: WeekSummary) => String(w.no)),
  );
}

// 週列の見出しは実際の日付（その週の開始日）。「第N週」より短く、いつの週かが直接わかる。
const weekHead = (w: WeekSummary): string => w.period.split('〜')[0];

// 週セルのマーク（S=SCAN / M=MAP、実施は緑・予約は橙）。cellText でタグは落ちるので絞り込み・出力もできる。
const marks = (r: MatrixRow, no: number): string => {
  const out: string[] = [];
  if (r.scanDoneWeek === no) out.push('<span class="qam-insp-mk is-done">S</span>');
  else if (r.scanSchedWeek === no) out.push('<span class="qam-insp-mk is-sched">S</span>');
  if (r.mapDoneWeeks.includes(no)) out.push('<span class="qam-insp-mk is-done">M</span>');
  else if (r.mapSchedWeeks.includes(no)) out.push('<span class="qam-insp-mk is-sched">M</span>');
  return out.join('');
};

// 対象×週マトリクス: 接続点ごとに SCAN と MAP を 1 行へ統合し、週列に両方を併記する。
function matrixSection(d: InspectionData): HTMLElement {
  const st = (s: InspStatus | null): string => (s ? `<span class="qam-insp-badge ${STATUS_CLASS[s]}">${STATUS_LABEL[s]}</span>` : '<span class="qam-insp-muted">対象外</span>');
  const stText = (s: InspStatus | null): string => (s ? STATUS_LABEL[s] : '対象外');
  const cols: Column[] = [
    { id: 'ag', label: '接続点ID', mono: true, render: (r: MatrixRow) => r.ag },
    { id: 'titles', label: 'AssetGroup タイトル', render: (r: MatrixRow) => r.titles.join(', ') },
    { id: 'scan', label: 'SCAN', render: (r: MatrixRow) => st(r.scanStatus), sortVal: (r: MatrixRow) => stText(r.scanStatus) },
    { id: 'map', label: 'MAP', render: (r: MatrixRow) => st(r.mapStatus), sortVal: (r: MatrixRow) => stText(r.mapStatus) },
    { id: 'domains', label: 'ドメイン', render: (r: MatrixRow) => (r.domains.length ? r.domains.join(', ') : '—') },
    ...d.weeks.map((w): Column => ({
      id: `w${w.no}`, label: weekHead(w), mono: true, width: 64,
      render: (r: MatrixRow) => marks(r, w.no) || '',
      sortVal: (r: MatrixRow) => (marks(r, w.no) ? '1' : '0'),
    })),
  ];
  return section(
    '対象 × 週 マトリクス',
    'S=SCAN / M=MAP。緑が実施済み、橙が予約（その週に実行予定）。週の見出しはその週の開始日。列名クリックで並べ替え・絞り込み。',
    commonTable('inspection.matrix', cols, d.matrix, (r: MatrixRow) => r.ag),
  );
}

// 対象母集団: AssetGroup 全件のうち何件がパターンに一致したか、一致しなかったのは何か。
// 「一部の AssetGroup しか出てこない」の理由をここで直接示す。
function populationSection(d: InspectionData): HTMLElement {
  const s = d.sources;
  const body = el('div', { class: 'qam-insp-src' }, [
    el('p', { class: 'qam-insp-sec-note' }, [
      `AssetGroup 全 ${s.agTotal} 件 → 接続点ID ${s.agMatched} 件が対象（対象外 ${s.agSkipped.length} 件）。`
      + `接続点ID は AssetGroup タイトルの先頭〜最初の半角スペースまでを切り出し、パターン ${d.pattern} で判定します。`,
    ]),
  ]);
  if (!s.agTotal) {
    body.append(el('p', { class: 'qam-insp-warn' }, [
      'AssetGroup のスナップショットがありません。先に「取込」から AssetGroup を取り込んでください。',
    ]));
    return section('対象母集団', '', body);
  }
  if (s.agSkipped.length) {
    body.append(
      el('p', { class: 'qam-insp-warn' }, [
        `対象外（${s.agSkipped.length} 件）: ${s.agSkipped.join(' / ')}`,
      ]),
      el('p', { class: 'qam-insp-sec-note' }, [
        'かっこ内が切り出した接続点ID です。ID が想定と違う場合はタイトルの区切り（半角スペース）を、'
        + 'ID は正しいのに対象外になる場合はパターンを、共通設定の「四半期検査: 対象 AssetGroup パターン」で調整してください。',
      ]),
    );
  }
  return section('対象母集団', 'どの AssetGroup が四半期検査の対象になっているか。', body);
}

// 取得内訳: 応答から何件読めたか。「取得したのに全部未対応」の切り分け用。
// 対象に紐づかなかったキーを出すことで、対象パターンのズレをその場で気付けるようにする。
function sourcesSection(d: InspectionData): HTMLElement {
  const s = d.sources;
  const body = el('div', { class: 'qam-insp-src' }, [
    table(
      ['応答', '応答の件数', '対象キーに展開', 'うち今四半期'],
      [
        ['実施済みスキャン', String(s.scanRunRows), String(s.scanRuns), String(s.scanRunsInQuarter)],
        ['実施済みマップ', String(s.mapRunRows), String(s.mapRuns), String(s.mapRunsInQuarter)],
        ['スキャンのスケジュール', String(s.scanSchedRows), String(s.scanScheds), '—'],
        ['マップのスケジュール', String(s.mapSchedRows), String(s.mapScheds), '—'],
      ],
      'qam-insp-weekly',
    ),
  ]);
  if (s.unmatchedScanAgs.length) {
    body.append(el('p', { class: 'qam-insp-warn' }, [
      `対象に含まれない接続点ID が実施済みスキャンに ${s.unmatchedScanAgs.length} 件ありました: ${s.unmatchedScanAgs.join(', ')}`,
    ]), el('p', { class: 'qam-insp-sec-note' }, [
      '検査は実施されているが、その接続点が対象母集団に入っていない状態です（AssetGroup 未取込か、パターン不一致）。',
    ]));
  }
  if (s.unmatchedMapDomains.length) {
    body.append(el('p', { class: 'qam-insp-warn' }, [
      `対象に含まれないドメインが実施済みマップに ${s.unmatchedMapDomains.length} 件ありました: ${s.unmatchedMapDomains.join(', ')}`,
    ]), el('p', { class: 'qam-insp-sec-note' }, [
      'AssetGroup の DOMAIN_LIST に登録されていないドメインが検査されています（MAP 対象は AssetGroup の登録ドメインから導出しています）。',
    ]));
  }
  // 「応答はあるのに対象キーへ展開できていない」＝応答に AssetGroup 名やドメインが入っていない。
  const gaps: string[] = [];
  if (s.scanRunRows && !s.scanRuns) gaps.push('実施済みスキャン（応答に AssetGroup 名が入っていない）');
  if (s.mapRunRows && !s.mapRuns) gaps.push('実施済みマップ（応答にドメインが入っていない）');
  if (s.scanSchedRows && !s.scanScheds) gaps.push('スキャンのスケジュール（応答に AssetGroup 名が入っていない）');
  if (s.mapSchedRows && !s.mapScheds) gaps.push('マップのスケジュール（応答にドメインが入っていない）');
  if (gaps.length) {
    body.append(el('p', { class: 'qam-insp-warn' }, [`応答は取得できているが対象キーを読み取れないものがあります: ${gaps.join(' / ')}`]),
      el('p', { class: 'qam-insp-sec-note' }, [
        '保存された応答XML（データフォルダの raw/<日付>/inspection-*.xml）で実際の要素名を確認してください。',
      ]));
  }
  if (!s.mapRunRows) {
    body.append(el('p', { class: 'qam-insp-sec-note' }, [
      '実施済みマップが 0 件の場合、マップが「レポートを保存する」設定で実行されていない可能性があります（保存されたマップレポートしか API から取得できません）。',
    ]));
  }
  return section('取得内訳（診断）', 'Qualys の応答から読み取れた件数。全て未対応になる場合はここを確認する。', body);
}

// エクスポート用シート（表示と同じ内容をテキストで）。
function sheets(d: InspectionData): Sheet[] {
  const target: Sheet = {
    name: '検査状況',
    headers: ['種別', '接続点ID/ドメイン', '関係する接続点ID', 'AssetGroupタイトル', '状態', '実施日', '予定日', '実施週'],
    rows: [...d.scan, ...d.map].map((r) => [
      kindLabel(r), r.key, r.kind === 'map' ? r.ags.join(' / ') : r.key, r.titles.join(' / '),
      STATUS_LABEL[r.status], fmtDate(r.doneAt), fmtDate(r.nextLaunch), r.weekNo ? `第${r.weekNo}週` : '',
    ]),
  };
  const weekly: Sheet = {
    name: '週次サマリ',
    headers: ['週', '期間', 'SCAN実施', 'SCAN予約', 'SCAN累計', 'MAP実施', 'MAP予約', 'MAP累計'],
    rows: d.weeks.map((w) => [`第${w.no}週`, w.period,
      String(w.scanDone), String(w.scanSched), String(w.scanCum),
      String(w.mapDone), String(w.mapSched), String(w.mapCum)]),
  };
  const matrix: Sheet = {
    name: '対象×週',
    headers: ['接続点ID', 'AssetGroupタイトル', 'SCAN', 'MAP', 'ドメイン', ...d.weeks.map((w) => `第${w.no}週`)],
    rows: d.matrix.map((r) => [
      r.ag, r.titles.join(' / '),
      r.scanStatus ? STATUS_LABEL[r.scanStatus] : '対象外',
      r.mapStatus ? STATUS_LABEL[r.mapStatus] : '対象外',
      r.domains.join(' / '),
      ...d.weeks.map((w) => {
        const s = r.scanDoneWeek === w.no ? 'S' : (r.scanSchedWeek === w.no ? 'S(予約)' : '');
        const m = r.mapDoneWeeks.includes(w.no) ? 'M' : (r.mapSchedWeeks.includes(w.no) ? 'M(予約)' : '');
        return [s, m].filter(Boolean).join(' ');
      }),
    ]),
  };
  const pending: Sheet = {
    name: '未対応接続点',
    headers: ['接続点ID', 'SCAN未対応', '未対応MAPドメイン'],
    rows: d.pending.map((p) => [p.ag, p.scanPending ? '未対応' : '', p.mapPendingDomains.join(' / ')]),
  };
  return [weekly, matrix, target, pending];
}

export interface InspectionViewOpts {
  data: InspectionData;
  busy: boolean;
  onFetch: () => void;
}

// ツールバー（取得・エクスポート）。取得中はボタンを止める。
function toolbarRow(o: InspectionViewOpts): HTMLElement {
  const d = o.data;
  const stamp = `QAM_四半期検査_${d.quarter.fy}Q${d.quarter.q}`;
  const fetchBtn = el('button', { class: 'btn btn--sm btn--primary', disabled: o.busy || undefined, html: `${icon('download', 14)}<span>${o.busy ? '取得中…' : 'Qualys から取得'}</span>` });
  fetchBtn.addEventListener('click', o.onFetch);
  const csvBtn = el('button', { class: 'btn btn--sm', html: `${icon('download', 14)}<span>CSV</span>` });
  csvBtn.addEventListener('click', () => exportCsv(sheets(d)[0], `${stamp}.csv`));
  const xlsxBtn = el('button', { class: 'btn btn--sm', html: `${icon('download', 14)}<span>Excel</span>` });
  xlsxBtn.addEventListener('click', () => exportXlsxBook(sheets(d), `${stamp}.xlsx`));
  const fetched = d.fetchedAt
    ? `最終取得 ${new Date(d.fetchedAt).toLocaleString('ja-JP')}`
    : '未取得（「Qualys から取得」を押してください）';
  return el('div', { class: 'qam-insp-toolbar' }, [
    fetchBtn, csvBtn, xlsxBtn,
    el('span', { class: 'qam-insp-fetched' }, [fetched]),
  ]);
}

// ビュー本体を組み立てて返す。
export function renderInspectionView(o: InspectionViewOpts): HTMLElement {
  const d = o.data;
  const period = `${d.quarter.start.toLocaleDateString('ja-JP')} 〜 ${d.quarter.end.toLocaleDateString('ja-JP')}`;
  const head = el('div', { class: 'qam-insp-head' }, [
    el('span', { class: 'qam-insp-q' }, [d.quarter.label]),
    el('span', { class: 'qam-insp-period' }, [period]),
  ]);
  const cards = el('div', { class: 'qam-insp-cards' }, [
    statCard('SCAN（AssetGroup 単位）', d.scan),
    statCard('MAP（ドメイン単位）', d.map),
  ]);
  // 並び: 達成率カード → 週次サマリ → 統合マトリクス → 母集団 → 取得内訳。
  // 未対応の一覧はマトリクスの SCAN/MAP 列で絞り込めるので独立セクションは置かない。
  return el('div', { class: 'qam-insp' }, [
    head, toolbarRow(o), cards,
    weeklySection(d), matrixSection(d),
    populationSection(d), sourcesSection(d),
  ]);
}

// 対象 AssetGroup が 0 件のときの案内（パターン不一致や group 未取込）。
// el() の children はテキストノードとして append されるので、ここでのエスケープは不要。
export function inspectionEmpty(patternSrc: string): HTMLElement {
  return el('div', { class: 'qam-insp-empty' }, [
    el('p', {}, ['AssetGroup のスナップショットがありません。']),
    el('p', {}, ['右上の「取込」から AssetGroup を取り込むと、四半期検査の対象を判定できます。']),
    el('p', {}, [`（取り込み済みなのに出ない場合は、対象パターン ${patternSrc} を共通設定で確認してください）`]),
  ]);
}
