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
  exportRef?: { fn?: () => ExportMatrix };
  filterRef?: FilterRef;                                          // フィルタ操作の窓口（任意）
  columnRef?: { open?: (anchor: HTMLElement) => void };          // 列表示メニューを開く窓口（ボタンは外側に置く）
}

// 描画上限。通常（数千件まで）は全件描画してスクロール表示。極端（数万件）の
// フリーズだけ保護する高い上限。超えた分のみ注記を出す。
const MAX_ROWS = 5000;

interface FilterCond { field: string; value: string }
interface TState { order: string[]; widths: Record<string, number>; sort: { col: string; dir: 1 | -1 } | null; filters: FilterCond[]; hidden: string[] }

function loadState(viewId: string): TState {
  try {
    const s = { order: [], widths: {}, sort: null, filters: [], hidden: [], ...JSON.parse(localStorage.getItem(LS.table(viewId)) || '{}') } as TState;
    // 旧形式（列ごとの Record<string,string>）からの移行: 値ありを追加順の配列へ。
    if (s.filters && !Array.isArray(s.filters)) s.filters = Object.entries(s.filters as Record<string, string>).filter(([, v]) => v).map(([field, value]) => ({ field, value }));
    if (!Array.isArray(s.hidden)) s.hidden = [];
    return s;
  } catch { return { order: [], widths: {}, sort: null, filters: [], hidden: [] }; }
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

export function renderTable(opts: TableOpts): HTMLElement {
  const st = loadState(opts.viewId);
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

  const widthOf = (c: Column) => st.widths[c.id] ?? (c.id === cols[0].id ? 220 : 160);

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
  function renderColMenu(): void {
    clear(colPop);
    colPop.append(el('div', { class: 'qam-colmenu-head' }, ['表示する列']));
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
      colPop.append(lab);
    });
  }
  // ボタンは main 側（エクスポート群の隣）に置く。ここでは開閉処理だけ公開する。
  if (opts.columnRef) opts.columnRef.open = (anchor: HTMLElement) => {
    if (colPop.classList.contains('on')) { colPop.classList.remove('on'); return; }
    renderColMenu();
    const r = anchor.getBoundingClientRect();
    colPop.style.left = `${Math.max(8, Math.min(r.right - 220, window.innerWidth - 228))}px`;
    colPop.style.top = `${r.bottom + 6}px`;
    colPop.classList.add('on');
  };
  colPop.addEventListener('click', (e) => e.stopPropagation());
  if (!colMenuBound) { document.addEventListener('click', () => document.getElementById('qam-colmenu')?.classList.remove('on')); colMenuBound = true; }

  // フィルタ: チップごとに、カンマ区切りの語の「いずれか」を含めば一致(OR)。複数チップはAND。
  function passesFilters(row: any): boolean {
    return st.filters.every((flt) => {
      const f = (flt.value || '').trim();
      if (!f) return true;
      const col = byId.get(flt.field);
      if (!col) return true;
      const text = cellText(col, row).toLowerCase();
      const terms = f.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      return terms.length === 0 || terms.some((t) => text.includes(t));
    });
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
  if (opts.exportRef) opts.exportRef.fn = () => ({
    headers: vcols().map((c) => c.label || c.id),
    rows: displayedRows().map((r) => vcols().map((c) => cellText(c, r))),
  });

  // フィルタ操作の窓口を main へ公開（チップUIは main 側が描画）。表示中の列のみ対象。
  if (opts.filterRef) {
    const fr = opts.filterRef;
    fr.cols = vcols().map((c) => ({ id: c.id, label: c.label || c.id, mono: c.mono }));
    fr.list = () => st.filters.map((f) => ({ id: f.field, label: byId.get(f.field)?.label || f.field, value: f.value }));
    fr.add = (id) => { if (!st.filters.some((f) => f.field === id)) st.filters.push({ field: id, value: '' }); saveState(opts.viewId, st); renderBody(); fr.onChange?.(); };
    fr.setValue = (id, val) => { const f = st.filters.find((x) => x.field === id); if (f) { f.value = val; saveState(opts.viewId, st); renderBody(); } };
    fr.remove = (id) => { st.filters = st.filters.filter((f) => f.field !== id); saveState(opts.viewId, st); renderBody(); fr.onChange?.(); };
    fr.clear = () => { st.filters = []; saveState(opts.viewId, st); renderBody(); fr.onChange?.(); };
  }

  function renderBody(): void {
    const old = table.querySelector('tbody'); if (old) old.remove();
    const tbody = el('tbody');
    const rows = displayedRows();
    for (const row of rows.slice(0, MAX_ROWS)) {
      const key = opts.getKey(row);
      const tr = el('tr', { class: opts.selected.has(key) ? 'qam-selected' : '' });
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = opts.selected.has(key);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { if (cb.checked) opts.selected.add(key); else opts.selected.delete(key); tr.classList.toggle('qam-selected', cb.checked); updateBulk(rows.length); opts.onSelectionChange?.(); });
      const tdC = el('td', { class: 'qam-col-check' }); tdC.append(cb); tr.append(tdC);
      vcols().forEach((c) => {
        const td = el('td', { class: c.mono ? 'qam-mono' : '' });
        const v = c.render(row);
        if (typeof v === 'string') td.innerHTML = v; else td.append(v);
        td.title = td.textContent || '';
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    updateBulk(rows.length);
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
    const sortIcon = st.sort?.col === c.id ? icon(st.sort.dir === 1 ? 'chevronUp' : 'chevronDown', 13) : '';
    const inner = el('div', { class: 'qam-th', html: `<span>${c.label}</span>${sortIcon}` });
    if (c.sortable !== false) inner.addEventListener('click', () => {
      const dir: 1 | -1 = st.sort && st.sort.col === c.id && st.sort.dir === 1 ? -1 : 1;
      st.sort = { col: c.id, dir }; saveState(opts.viewId, st); render();
    });
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

  render();
  return section;
}
