// 共通テーブル（Notion §25 準拠）: 行/全件選択・ソート・列幅リサイズ・列入替（pointer 自前実装）・
// 列幅/順序/ソートの localStorage 永続化・選択時バルクバー常設。
import { el, clear } from './dom';
import { icon } from '../icons';
import { LS } from '../config';

export interface Column {
  id: string;
  label: string;
  mono?: boolean;
  sortable?: boolean;
  width?: number;   // 既定の列幅(px)。保存済みの幅があればそちらが優先される。
  render: (row: any) => string | Node;
  sortVal?: (row: any) => string;
}
export interface ExportMatrix { headers: string[]; rows: string[][] }
// フィルタ操作の窓口（チップUIは外＝main側が描画。テーブルは適用・永続・本体再描画を担う）。
export interface FilterRef {
  cols: { id: string; label: string; mono?: boolean }[];          // フィルタ可能な列（描画時にテーブルが設定）
  list: () => { id: string; label: string; value: string }[];     // 現在のチップ（追加順）
  add: (id: string) => void;                                      // 空チップ追加
  setValue: (id: string, value: string) => void;                  // 値変更（本体のみ再描画＝入力フォーカス維持）
  remove: (id: string) => void;                                   // チップ削除
  clear: () => void;                                              // 列フィルタを全消去
  onChange?: () => void;                                          // 追加/削除時に main がチップを再描画
}
export interface TableOpts {
  viewId: string;
  columns: Column[];
  rows: any[];
  getKey: (row: any) => string;
  selected: Set<string>;
  onSelectionChange?: () => void;
  bulkActions?: (keys: string[]) => HTMLElement[];
  // 現在の表示（フィルタ・並べ替え後）をテキスト行列で取り出す関数を受け取る箱（エクスポート用）。
  exportRef?: { fn?: () => ExportMatrix; rows?: () => any[] };
  filterRef?: FilterRef;                                          // フィルタ操作の窓口（任意）
  columnRef?: { open?: (anchor: HTMLElement) => void };          // 列表示メニューを開く窓口（ボタンは外側に置く）
  onRowClick?: (row: any) => void;                                // 行クリック（チェックボックス/編集セル等は stopPropagation 済みなので発火しない）
  defaultHidden?: string[];                                       // 既定で隠す列ID（保存状態が無い/レイアウト版更新時に適用）
}

// 描画上限。通常は全件描画してスクロール表示。極端な件数でのフリーズだけ保護する高い上限。
// 超えた分は注記を出す（期間/種別/フィルタで絞り込めば全件追える）。変更履歴は CSV 取込＋
// 差分で件数が増えやすいので 5000→20000 に引き上げ。
const MAX_ROWS = 20000;

interface FilterCond { field: string; value: string }
// excluded: 列ID → その列で「チェックを外した（＝非表示にする）値」の配列（Excel オートフィルタ相当）。
interface TState { order: string[]; widths: Record<string, number>; sort: { col: string; dir: 1 | -1 } | null; filters: FilterCond[]; hidden: string[]; excluded: Record<string, string[]>; v?: number }

// 既定の列順・表示/非表示を変えたら上げる。旧保存状態の order/hidden を1度だけ既定へ初期化（widths/sort/filters は保持）。
const TABLE_VERSION = 2;

function loadState(viewId: string, defaultHidden: string[] = []): TState {
  const def = (): TState => ({ order: [], widths: {}, sort: null, filters: [], hidden: [...defaultHidden], excluded: {}, v: TABLE_VERSION });
  const raw = localStorage.getItem(LS.table(viewId));
  if (!raw) return def();
  try {
    const s = { ...def(), ...JSON.parse(raw) } as TState;
    // 旧形式（列ごとの Record<string,string>）からの移行: 値ありを追加順の配列へ。
    if (s.filters && !Array.isArray(s.filters)) s.filters = Object.entries(s.filters as Record<string, string>).filter(([, v]) => v).map(([field, value]) => ({ field, value }));
    if (!Array.isArray(s.hidden)) s.hidden = [];
    if (!s.excluded || typeof s.excluded !== 'object') s.excluded = {};
    // 既定レイアウト更新時は order/hidden を既定へ初期化（1度だけ）。
    if (s.v !== TABLE_VERSION) { s.order = []; s.hidden = [...defaultHidden]; s.v = TABLE_VERSION; }
    return s;
  } catch { return def(); }
}
const saveState = (viewId: string, s: TState) => localStorage.setItem(LS.table(viewId), JSON.stringify(s));

// セルの表示テキスト（フィルタ照合・エクスポート用）。render が HTML 文字列でもタグを除いた文字列にする。
export function cellText(col: Column, row: any): string {
  if (col.sortVal) return col.sortVal(row);
  const v = col.render(row);
  if (typeof v !== 'string') return (v as Node).textContent ?? '';
  const d = document.createElement('div'); d.innerHTML = v; return d.textContent ?? '';
}

let colMenuBound = false;

// マウスカーソルが一覧(.qam-tablewrap)の上にある時、PageUp/PageDown でその表をスクロールする。
// （スクロール対象にフォーカスが無いとキーが効かないため。タブ切替後も最後のマウス位置で判定）。
let keyNavBound = false;
let lastMx = 0; let lastMy = 0;
function bindTableKeyNav(): void {
  if (keyNavBound) return; keyNavBound = true;
  document.addEventListener('mousemove', (e) => { lastMx = e.clientX; lastMy = e.clientY; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // 入力欄の操作は邪魔しない
    const w = (document.elementFromPoint(lastMx, lastMy) as HTMLElement | null)?.closest('.qam-tablewrap') as HTMLElement | null;
    if (!w) return;
    const page = Math.max(40, w.clientHeight - 40); // 1ページ＝表示高さ（少し重ねる）
    w.scrollTop += (e.key === 'PageDown' ? page : -page);
    e.preventDefault();
  });
}

export function renderTable(opts: TableOpts): HTMLElement {
  bindTableKeyNav();
  const st = loadState(opts.viewId, opts.defaultHidden ?? []);
  const byId = new Map(opts.columns.map((c) => [c.id, c]));
  let cols = st.order.map((id) => byId.get(id)!).filter(Boolean);
  for (const c of opts.columns) if (!cols.includes(c)) cols.push(c);
  // 表示列（非表示を除く）。順序・リサイズは全 cols、描画は vcols。
  const vcols = (): Column[] => cols.filter((c) => !st.hidden.includes(c.id));

  const section = el('div', { class: 'qam-section', style: 'display:grid;grid-template-rows:auto 1fr;min-height:0;height:100%' });
  const bulk = el('div', { class: 'qam-bulk' });
  const bulkInfo = el('div', { class: 'qam-bulk-info' });
  bulk.append(bulkInfo);
  const wrap = el('div', { class: 'qam-tablewrap' });
  const table = el('table', { class: 'qam-table' });
  wrap.append(table);
  section.append(bulk, wrap);

  const widthOf = (c: Column) => st.widths[c.id] ?? c.width ?? (c.id === cols[0].id ? 220 : 160);

  function updateBulk(shown: number): void {
    clear(bulkInfo);
    const keys = [...opts.selected];
    const total = opts.rows.length;
    let note = '';
    if (shown < total) note = `（全 ${total.toLocaleString()} 件中 ${shown.toLocaleString()} 件）`;
    else if (total > MAX_ROWS) note = `（先頭 ${MAX_ROWS} 件表示）`;
    bulkInfo.append(el('span', {}, [keys.length ? `${keys.length} 件選択中` : `${total.toLocaleString()} 件${note}`]));
    if (keys.length && opts.bulkActions) {
      const acts = el('div', { class: 'qam-bulk-actions' });
      opts.bulkActions(keys).forEach((b) => acts.append(b));
      bulkInfo.append(acts);
    }
  }

  // 列表示メニュー（チェックで表示/非表示）。body 直下に1つだけ置く。
  document.getElementById('qam-colmenu')?.remove();
  const colPop = el('div', { class: 'qam-colmenu', id: 'qam-colmenu' });
  document.body.append(colPop);
  const openAt = (anchor: HTMLElement): void => {
    const r = anchor.getBoundingClientRect();
    colPop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`;
    colPop.style.top = `${r.bottom + 6}px`;
    colPop.classList.add('on');
  };

  // 「列表示」ボタン: 表示する列のチェックリスト（列の表示/非表示）。
  function openColumnList(anchor: HTMLElement): void {
    if (colPop.classList.contains('on')) { colPop.classList.remove('on'); return; }
    clear(colPop);
    colPop.append(el('div', { class: 'qam-colmenu-head' }, ['表示する列']));
    // リストは内側だけスクロール（外側ポップオーバーは中身に合わせて伸びる＝二重スクロール防止）。
    const listWrap = el('div', { class: 'qam-colmenu-vlist' });
    cols.forEach((c) => {
      const lab = el('label', { class: 'qam-colmenu-item' });
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = !st.hidden.includes(c.id);
      cb.addEventListener('change', () => {
        if (cb.checked) st.hidden = st.hidden.filter((x) => x !== c.id);
        else if (!st.hidden.includes(c.id)) st.hidden.push(c.id);
        saveState(opts.viewId, st); render();
      });
      lab.append(cb, el('span', {}, [c.label || c.id]));
      listWrap.append(lab);
    });
    colPop.append(listWrap);
    openAt(anchor);
  }
  if (opts.columnRef) opts.columnRef.open = openColumnList;

  // 列名クリック: Excel オートフィルタ（並べ替え＋その列の値リストをチェックで表示/非表示）。
  function openValueFilter(anchor: HTMLElement, col: Column): void {
    if (colPop.classList.contains('on')) { colPop.classList.remove('on'); return; }
    clear(colPop);
    const setSort = (dir: 1 | -1): void => { st.sort = { col: col.id, dir }; saveState(opts.viewId, st); colPop.classList.remove('on'); render(); };
    if (col.sortable !== false) {
      const asc = el('button', { class: 'qam-colmenu-item qam-colmenu-act', html: `${icon('chevronUp', 13)}<span>昇順で並べ替え</span>` });
      const desc = el('button', { class: 'qam-colmenu-item qam-colmenu-act', html: `${icon('chevronDown', 13)}<span>降順で並べ替え</span>` });
      asc.addEventListener('click', () => setSort(1));
      desc.addEventListener('click', () => setSort(-1));
      colPop.append(asc, desc, el('div', { class: 'qam-colmenu-sep' }));
    }
    // その列の登録値（一意・昇順）。空は「(空白)」表示。最大 2000 件で頭打ち。
    const values = [...new Set(opts.rows.map((r) => cellText(col, r)))].sort((a, b) => a.localeCompare(b));
    const capped = values.slice(0, 2000);
    const ex = new Set(st.excluded[col.id] ?? []);
    const apply = (): void => { const arr = [...ex]; if (arr.length) st.excluded[col.id] = arr; else delete st.excluded[col.id]; saveState(opts.viewId, st); renderBody(); render(); };

    const head = el('div', { class: 'qam-colmenu-head' }, [`${col.label || col.id} の値で絞り込み`]);
    const search = el('input', { class: 'qam-colmenu-search', type: 'text', placeholder: '値を検索' }) as HTMLInputElement;
    const listWrap = el('div', { class: 'qam-colmenu-vlist' });
    colPop.append(head, search);
    // (すべて選択)
    const allLab = el('label', { class: 'qam-colmenu-item qam-colmenu-all' });
    const allCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    allLab.append(allCb, el('span', {}, ['(すべて選択)']));
    colPop.append(allLab, listWrap);
    if (values.length > capped.length) colPop.append(el('div', { class: 'qam-colmenu-note' }, [`値が多いため先頭 ${capped.length} 件のみ`]));

    // 表示は常に ex の純粋関数。チェック切替のたびに再描画して「再表示時にチェック位置がずれる」のを防ぐ。
    // スクロール位置は維持。
    const renderList = (q: string): void => {
      const scroll = listWrap.scrollTop;
      clear(listWrap);
      const ql = q.trim().toLowerCase();
      const shown = capped.filter((v) => !ql || (v || '(空白)').toLowerCase().includes(ql));
      allCb.checked = shown.length > 0 && shown.every((v) => !ex.has(v));
      allCb.indeterminate = shown.some((v) => !ex.has(v)) && shown.some((v) => ex.has(v));
      for (const v of shown) {
        const lab = el('label', { class: 'qam-colmenu-item' });
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !ex.has(v);
        cb.addEventListener('change', () => { if (cb.checked) ex.delete(v); else ex.add(v); apply(); renderList(search.value); });
        lab.append(cb, el('span', {}, [v === '' ? '(空白)' : v]));
        listWrap.append(lab);
      }
      listWrap.scrollTop = scroll;
    };
    allCb.addEventListener('change', () => {
      const ql = search.value.trim().toLowerCase();
      const shown = capped.filter((v) => !ql || (v || '(空白)').toLowerCase().includes(ql));
      if (allCb.checked) shown.forEach((v) => ex.delete(v)); else shown.forEach((v) => ex.add(v));
      apply(); renderList(search.value);
    });
    // 検索ボックス入力: 入力文字を含む値だけを「選択(チェック)」状態にし、それ以外を除外して即適用。
    // 空入力なら全選択に戻す。表示リストは一致値（＝チェック済み）のみ。Enter/外側クリックで保ったまま閉じる。
    search.addEventListener('input', () => {
      const ql = search.value.trim().toLowerCase();
      ex.clear();
      if (ql) for (const v of values) if (!(v || '(空白)').toLowerCase().includes(ql)) ex.add(v);
      apply();
      renderList(search.value);
    });
    // Enter で絞り込みポップオーバーを閉じる（検索フィルタは適用済みのまま保持）。IME 変換確定の Enter は無視。
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); colPop.classList.remove('on'); } });
    renderList('');
    openAt(anchor);
    setTimeout(() => search.focus(), 30);
  }

  colPop.addEventListener('click', (e) => e.stopPropagation());
  if (!colMenuBound) {
    document.addEventListener('click', () => document.getElementById('qam-colmenu')?.classList.remove('on'));
    // ESC で列フィルタ/列表示メニューを閉じる（検索ボックスにフォーカスがあっても document まで伝播する）。
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('qam-colmenu')?.classList.remove('on'); });
    colMenuBound = true;
  }

  // フィルタ: (1)チップ substring(カンマOR/複数列AND) (2)列ごとオートフィルタ(除外値)。両方 AND。
  function passesFilters(row: any): boolean {
    for (const flt of st.filters) {
      const f = (flt.value || '').trim();
      if (!f) continue;
      const col = byId.get(flt.field);
      if (!col) continue;
      const text = cellText(col, row).toLowerCase();
      const terms = f.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (terms.length && !terms.some((t) => text.includes(t))) return false;
    }
    for (const colId of Object.keys(st.excluded)) {
      const ex = st.excluded[colId];
      if (!ex || !ex.length) continue;
      const col = byId.get(colId);
      if (!col) continue;
      if (ex.includes(cellText(col, row))) return false; // チェックを外した値は非表示
    }
    return true;
  }
  function sortedRows(): any[] {
    if (!st.sort) return opts.rows;
    const col = byId.get(st.sort.col);
    if (!col) return opts.rows;
    const val = col.sortVal ?? ((r: any) => String(col.render(r)));
    return [...opts.rows].sort((a, b) => val(a).localeCompare(val(b)) * st.sort!.dir);
  }
  const displayedRows = (): any[] => sortedRows().filter(passesFilters);

  // エクスポート: 現在表示中（フィルタ・並べ替え後）の全行をテキスト行列に。列順も画面どおり。
  // rows() は表示中の生データ行も公開する（呼び出し側が独自のエクスポートを組み立てる用＝変更履歴の前後展開）。
  if (opts.exportRef) {
    opts.exportRef.fn = () => ({
      headers: vcols().map((c) => c.label || c.id),
      rows: displayedRows().map((r) => vcols().map((c) => cellText(c, r))),
    });
    opts.exportRef.rows = () => displayedRows();
  }

  // フィルタ操作の窓口を main へ公開（チップUIは main 側が描画）。表示中の列のみ対象。
  if (opts.filterRef) {
    const fr = opts.filterRef;
    fr.cols = vcols().map((c) => ({ id: c.id, label: c.label || c.id, mono: c.mono }));
    fr.list = () => st.filters.map((f) => ({ id: f.field, label: byId.get(f.field)?.label || f.field, value: f.value }));
    fr.add = (id) => { if (!st.filters.some((f) => f.field === id)) st.filters.push({ field: id, value: '' }); saveState(opts.viewId, st); renderBody(); fr.onChange?.(); };
    fr.setValue = (id, val) => { const f = st.filters.find((x) => x.field === id); if (f) { f.value = val; saveState(opts.viewId, st); renderBody(); } };
    fr.remove = (id) => { st.filters = st.filters.filter((f) => f.field !== id); saveState(opts.viewId, st); renderBody(); fr.onChange?.(); };
    fr.clear = () => { st.filters = []; st.excluded = {}; saveState(opts.viewId, st); render(); fr.onChange?.(); }; // チップ＋列オートフィルタを一括解除
  }

  function buildRow(row: any, vc: Column[]): HTMLElement {
    const key = opts.getKey(row);
    const tr = el('tr', { class: 'qam-data' + (opts.selected.has(key) ? ' qam-selected' : '') + (opts.onRowClick ? ' qam-row-click' : '') });
    if (opts.onRowClick) {
      let downX = 0; let downY = 0;
      tr.addEventListener('mousedown', (e) => { downX = e.clientX; downY = e.clientY; });
      tr.addEventListener('click', (e) => {
        if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
        if ((window.getSelection()?.toString() ?? '').length > 0) return;
        opts.onRowClick!(row);
      });
    }
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = opts.selected.has(key);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { if (cb.checked) opts.selected.add(key); else opts.selected.delete(key); tr.classList.toggle('qam-selected', cb.checked); updateBulk(winRows.length); opts.onSelectionChange?.(); });
    const tdC = el('td', { class: 'qam-col-check' }); tdC.append(cb); tr.append(tdC);
    vc.forEach((c) => {
      const td = el('td', { class: c.mono ? 'qam-mono' : '' });
      const v = c.render(row);
      if (typeof v === 'string') td.innerHTML = v; else td.append(v);
      td.title = td.textContent || '';
      tr.append(td);
    });
    return tr;
  }

  // 仮想スクロール: 行が多いとき可視範囲＋バッファのみ DOM 化。残りは上下の spacer 行で高さを確保。
  const VIRT_MIN = 60;
  const VBUF = 10;
  let winRows: any[] = [];
  let rowH = 36;
  let virtual = false;
  let topSpacer: HTMLElement | null = null;
  let botSpacer: HTMLElement | null = null;
  let lastStart = -1;
  let tbodyEl: HTMLElement | null = null;

  function windowRange(): [number, number] {
    const n = winRows.length;
    const vh = wrap.clientHeight || window.innerHeight || 800;
    let start = Math.floor(wrap.scrollTop / rowH) - VBUF; if (start < 0) start = 0;
    let end = start + Math.ceil(vh / rowH) + VBUF * 2; if (end > n) end = n;
    return [start, end];
  }

  function paintWindow(): void {
    if (!tbodyEl) return;
    const vc = vcols();
    const [start, end] = windowRange();
    lastStart = start;
    // データ行を一旦すべて外すと表の幅が縮み、ブラウザが横スクロール位置を切り詰める
    // （＝縦スクロールしただけで表が右へ戻る）。入れ替えの前後で scrollLeft を保持する。
    const keepX = wrap.scrollLeft;
    // spacer は内側 div に高さを持たせる（fixed-layout の td 直接 height は無視されることがある）。
    (topSpacer!.firstElementChild as HTMLElement).style.height = `${start * rowH}px`;
    (botSpacer!.firstElementChild as HTMLElement).style.height = `${(winRows.length - end) * rowH}px`;
    // データ行だけ入れ替え（spacer は据え置き）。
    let node = topSpacer!.nextSibling;
    while (node && node !== botSpacer) { const next = node.nextSibling; tbodyEl.removeChild(node); node = next; }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(buildRow(winRows[i], vc));
    tbodyEl.insertBefore(frag, botSpacer);
    if (wrap.scrollLeft !== keepX) wrap.scrollLeft = keepX;
  }

  function renderBody(): void {
    const old = table.querySelector('tbody'); if (old) old.remove();
    winRows = displayedRows().slice(0, MAX_ROWS);
    virtual = winRows.length > VIRT_MIN && !table.classList.contains('qam-wrap');
    const tbody = el('tbody'); tbodyEl = tbody;
    if (!virtual) {
      const vc = vcols();
      for (const row of winRows) tbody.append(buildRow(row, vc));
      topSpacer = botSpacer = null;
    } else {
      const colspan = String(vcols().length + 1);
      topSpacer = el('tr', { class: 'qam-vspacer' }, [el('td', { colspan }, [el('div', {})])]);
      botSpacer = el('tr', { class: 'qam-vspacer' }, [el('td', { colspan }, [el('div', {})])]);
      tbody.append(topSpacer, botSpacer);
      lastStart = -1;
      paintWindow();
    }
    table.append(tbody);
    updateBulk(winRows.length);
  }

  function render(): void {
    clear(table);
    const colgroup = el('colgroup');
    colgroup.append(el('col', { style: 'width:38px' }));
    vcols().forEach((c) => colgroup.append(el('col', { style: `width:${widthOf(c)}px` })));
    table.append(colgroup);
    setTableWidth();

    // ---- thead: ヘッダ行 ----
    const shownKeys = displayedRows().map(opts.getKey);
    const selCount = shownKeys.filter((k) => opts.selected.has(k)).length;
    const selAll = el('input', { type: 'checkbox' }) as HTMLInputElement;
    selAll.checked = selCount > 0 && selCount === shownKeys.length;
    selAll.indeterminate = selCount > 0 && selCount < shownKeys.length;
    selAll.addEventListener('change', () => {
      if (selAll.checked) shownKeys.forEach((k) => opts.selected.add(k));
      else shownKeys.forEach((k) => opts.selected.delete(k));
      render(); opts.onSelectionChange?.();
    });
    const thCheck = el('th', { class: 'qam-col-check' }); thCheck.append(selAll);
    const trH = el('tr'); trH.append(thCheck);
    vcols().forEach((c) => trH.append(buildTh(c)));
    const thead = el('thead'); thead.append(trH); table.append(thead);

    renderBody();
  }

  function buildTh(c: Column): HTMLElement {
    const th = el('th', { dataset: { col: c.id } });
    // 右側アイコンは1つだけ: ソート中はその向きの矢印、未ソートならドロップダウン caret。
    // フィルタが効いている列は caret を強調（フィルタ中の目印）。
    const sorted = st.sort?.col === c.id;
    const filtered = (st.excluded[c.id]?.length ?? 0) > 0;
    const rightIcon = sorted ? icon(st.sort!.dir === 1 ? 'chevronUp' : 'chevronDown', 12) : icon('chevronDown', 12);
    const funnel = filtered ? `<span class="qam-th-funnel" title="この列で絞り込み中">${icon('filter', 12)}</span>` : '';
    const inner = el('div', { class: 'qam-th' + (filtered ? ' qam-th-filtered' : ''), html: `<span class="qam-th-lbl">${c.label}</span><span class="qam-th-icons">${funnel}<span class="qam-th-caret">${rightIcon}</span></span>` });
    // 列名クリックで Excel オートフィルタ（並べ替え＋値リスト）。外側クリック判定で即閉じしないよう伝播停止。
    inner.addEventListener('click', (e) => { e.stopPropagation(); openValueFilter(th, c); });
    th.append(inner);
    attachReorder(th, c);
    th.append(buildResize(c));
    return th;
  }

  function buildResize(c: Column): HTMLElement {
    const h = el('div', { class: 'qam-th-resize' });
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX; const startW = widthOf(c);
      const move = (ev: PointerEvent) => { st.widths[c.id] = Math.max(60, startW + (ev.clientX - startX)); applyWidths(); };
      const up = () => { saveState(opts.viewId, st); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
    return h;
  }

  // テーブル幅を「列幅の合計」に固定する。width:100% のままだと table-layout:fixed が
  // 列幅を 100% に再配分し、1 列を広げると他列（左側含む）がずれる。合計幅にすれば各列は独立。
  function setTableWidth(): void {
    const total = 38 + vcols().reduce((s, c) => s + widthOf(c), 0);
    table.style.width = `${total}px`;
  }
  function applyWidths(): void {
    const colEls = table.querySelectorAll('colgroup col');
    vcols().forEach((c, i) => { (colEls[i + 1] as HTMLElement).style.width = `${widthOf(c)}px`; });
    setTableWidth();
  }

  // 列入替（pointer 自前。native draggable は使わない・§12/§25.4）
  function attachReorder(th: HTMLElement, c: Column): void {
    th.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).classList.contains('qam-th-resize')) return;
      const startX = e.clientX; let dragging = false; let overId: string | null = null;
      const move = (ev: PointerEvent) => {
        if (!dragging && Math.abs(ev.clientX - startX) < 6) return;
        dragging = true;
        const el2 = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const overTh = el2?.closest('th[data-col]') as HTMLElement | null;
        table.querySelectorAll('th.qam-drag-over').forEach((x) => x.classList.remove('qam-drag-over'));
        if (overTh && overTh.dataset.col !== c.id) { overTh.classList.add('qam-drag-over'); overId = overTh.dataset.col!; }
        else overId = null;
      };
      const up = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        table.querySelectorAll('th.qam-drag-over').forEach((x) => x.classList.remove('qam-drag-over'));
        if (dragging && overId) {
          const from = cols.findIndex((x) => x.id === c.id); const to = cols.findIndex((x) => x.id === overId);
          if (from >= 0 && to >= 0) { const [m] = cols.splice(from, 1); cols.splice(to, 0, m); st.order = cols.map((x) => x.id); saveState(opts.viewId, st); render(); }
        }
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
  }

  // スクロールで可視範囲(start)が変わったら、データ行だけ入れ替える（rAF で間引き）。
  let rafPending = false;
  wrap.addEventListener('scroll', () => {
    if (!virtual) return;
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const start = Math.max(0, Math.floor(wrap.scrollTop / rowH) - VBUF);
      if (start !== lastStart) paintWindow();
    });
  });
  // 全文表示トグル（外部が .qam-wrap を付け外し）に追従して描画方式を切り替える。
  new MutationObserver(() => renderBody()).observe(table, { attributes: true, attributeFilter: ['class'] });

  render();
  // 取り付け後に実際の行高を測って補正（detached では測れないため）。
  requestAnimationFrame(() => {
    if (!virtual) return;
    const probe = table.querySelector('tbody tr.qam-data') as HTMLElement | null;
    const h = probe?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - rowH) > 1) { rowH = h; lastStart = -1; paintWindow(); }
  });
  return section;
}
