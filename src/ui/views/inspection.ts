// 四半期検査ビュー: 現四半期の SCAN/MAP 充足状況・未対応 AssetGroup・週次の振り返り。
// ライセンス数推移ビューと同じ「カスタム DOM のダッシュボード」型（縦に積むため仮想スクロール表は使わない）。
import { el } from '../dom';
import { icon } from '../../icons';
import { exportCsv, exportXlsxBook, type Sheet } from '../../export';
import { countStatus, type InspectionData, type InspRow, type InspStatus } from '../../inspection';

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

// 状態バッジ。
const badge = (s: InspStatus): HTMLElement =>
  el('span', { class: `qam-insp-badge ${STATUS_CLASS[s]}` }, [STATUS_LABEL[s]]);

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

// 未対応 AssetGroup の一覧。SCAN 未実施か、登録ドメインに未対応 MAP がある AG を挙げる。
function pendingSection(d: InspectionData): HTMLElement {
  if (!d.pending.length) {
    return section('未対応の AssetGroup', '', el('p', { class: 'qam-insp-ok' }, ['未対応はありません。']));
  }
  const rows = d.pending.map((p) => [
    p.ag,
    p.scanPending ? badge('pending') : el('span', { class: 'qam-insp-muted' }, ['—']),
    p.mapPendingDomains.length ? p.mapPendingDomains.join(', ') : '—',
  ]);
  return section(
    '未対応の AssetGroup',
    '現四半期に実施も予定も無いもの。MAP 列は未対応のドメイン（ドメイン未登録の AG は MAP 対象外）。',
    table(['AssetGroup', 'SCAN', '未対応の MAP ドメイン'], rows, 'qam-insp-pending'),
  );
}

// 週次サマリ: その週の実施件数と累計・カバレッジ。
function weeklySection(d: InspectionData): HTMLElement {
  const scanTotal = d.scan.length;
  const mapTotal = d.map.length;
  const pct = (n: number, t: number): string => (t ? `${Math.round((n / t) * 100)}%` : '—');
  const rows = d.weeks.map((w) => [
    `第${w.no}週`,
    w.label.replace(/^第\d+週 \((.*)\)$/, '$1'),
    String(w.scanDone), `${w.scanCum} / ${scanTotal}（${pct(w.scanCum, scanTotal)}）`,
    String(w.mapDone), `${w.mapCum} / ${mapTotal}（${pct(w.mapCum, mapTotal)}）`,
  ]);
  return section(
    '週次サマリ',
    'その週に実施された件数と、四半期開始からの累計カバレッジ。',
    table(['週', '期間', 'SCAN 実施', 'SCAN 累計', 'MAP 実施', 'MAP 累計'], rows, 'qam-insp-weekly'),
  );
}

// 対象×週マトリクス: 各対象がどの週に実施されたか。未対応は行ごと色分け。
function matrixSection(d: InspectionData): HTMLElement {
  const all = [...d.scan, ...d.map];
  const headers = ['種別', '対象', '所属 AssetGroup', '状態', '実施日 / 予定日', ...d.weeks.map((w) => `第${w.no}週`)];
  const rows = all.map((r) => [
    kindLabel(r),
    r.key,
    r.kind === 'map' ? r.ags.join(', ') : '—',
    badge(r.status),
    fmtDate(r.doneAt || r.nextLaunch),
    ...d.weeks.map((w) => (r.weekNo === w.no ? el('span', { class: 'qam-insp-dot', title: '実施' }) : el('span', { class: 'qam-insp-muted' }, ['']))),
  ]);
  return section(
    '対象 × 週 マトリクス',
    '各 AssetGroup / ドメインが、どの週に検査されたか。実施週にマークが付く。',
    table(headers, rows, 'qam-insp-matrix'),
  );
}

// 対象母集団: AssetGroup 全件のうち何件がパターンに一致したか、一致しなかったのは何か。
// 「一部の AssetGroup しか出てこない」の理由をここで直接示す。
function populationSection(d: InspectionData): HTMLElement {
  const s = d.sources;
  const body = el('div', { class: 'qam-insp-src' }, [
    el('p', { class: 'qam-insp-sec-note' }, [
      `AssetGroup 全 ${s.agTotal} 件のうち ${s.agMatched} 件が対象パターン ${d.pattern} に一致（対象外 ${s.agSkipped.length} 件）。`,
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
        `対象外になった AssetGroup（${s.agSkipped.length} 件）: ${s.agSkipped.join(', ')}`,
      ]),
      el('p', { class: 'qam-insp-sec-note' }, [
        'パターンは「タイトル全体」に対する完全一致です（^ と $ で囲まれているため、'
        + 'タイトルに拠点名などが付いていると一致しません）。前方一致にしたい場合は末尾の $ を外し、'
        + '一部だけを対象にしたい場合は接頭辞を限定してください。共通設定の「四半期検査: 対象 AssetGroup パターン」で変更できます。',
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
      ['応答', '読めた件数', 'うち今四半期'],
      [
        ['実施済みスキャン', String(s.scanRuns), String(s.scanRunsInQuarter)],
        ['実施済みマップ', String(s.mapRuns), String(s.mapRunsInQuarter)],
        ['スキャンのスケジュール', String(s.scanScheds), '—'],
        ['マップのスケジュール', String(s.mapScheds), '—'],
      ],
      'qam-insp-weekly',
    ),
  ]);
  if (s.unmatchedScanAgs.length) {
    body.append(el('p', { class: 'qam-insp-warn' }, [
      `対象に含まれない AssetGroup が実施済みスキャンに ${s.unmatchedScanAgs.length} 件ありました: ${s.unmatchedScanAgs.join(', ')}`,
    ]), el('p', { class: 'qam-insp-sec-note' }, [
      '実際に検査されている AssetGroup が対象パターンに一致していない可能性があります。共通設定の「四半期検査: 対象 AssetGroup パターン」を実態に合わせてください。',
    ]));
  }
  if (s.unmatchedMapDomains.length) {
    body.append(el('p', { class: 'qam-insp-warn' }, [
      `対象に含まれないドメインが実施済みマップに ${s.unmatchedMapDomains.length} 件ありました: ${s.unmatchedMapDomains.join(', ')}`,
    ]), el('p', { class: 'qam-insp-sec-note' }, [
      'AssetGroup の DOMAIN_LIST に登録されていないドメインが検査されています（MAP 対象は AssetGroup の登録ドメインから導出しています）。',
    ]));
  }
  if (!s.mapRuns) {
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
    headers: ['種別', '対象', '所属AssetGroup', '状態', '実施日', '予定日', '実施週'],
    rows: [...d.scan, ...d.map].map((r) => [
      kindLabel(r), r.key, r.kind === 'map' ? r.ags.join(' / ') : '',
      STATUS_LABEL[r.status], fmtDate(r.doneAt), fmtDate(r.nextLaunch), r.weekNo ? `第${r.weekNo}週` : '',
    ]),
  };
  const weekly: Sheet = {
    name: '週次サマリ',
    headers: ['週', '期間', 'SCAN実施', 'SCAN累計', 'MAP実施', 'MAP累計'],
    rows: d.weeks.map((w) => [`第${w.no}週`, w.label.replace(/^第\d+週 \((.*)\)$/, '$1'),
      String(w.scanDone), String(w.scanCum), String(w.mapDone), String(w.mapCum)]),
  };
  const pending: Sheet = {
    name: '未対応AssetGroup',
    headers: ['AssetGroup', 'SCAN未対応', '未対応MAPドメイン'],
    rows: d.pending.map((p) => [p.ag, p.scanPending ? '未対応' : '', p.mapPendingDomains.join(' / ')]),
  };
  return [target, weekly, pending];
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
  return el('div', { class: 'qam-insp' }, [
    head, toolbarRow(o), cards,
    populationSection(d), pendingSection(d), sourcesSection(d), weeklySection(d), matrixSection(d),
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
