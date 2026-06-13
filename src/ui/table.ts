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
export interface TableOpts {
  viewId: string;
  columns: Column[];
  rows: any[];
  getKey: (row: any) => string;
  selected: Set<string>;
  onSelectionChange?: () => void;
  bulkActions?: (keys: string[]) => HTMLElement[];
}

// 描画上限。通常（数千件まで）は全件描画してスクロール表示。極端（数万件）の
// フリーズだけ保護する高い上限。超えた分のみ注記を出す。
const MAX_ROWS = 5000;

interface TState { order: string[]; widths: Record<string, number>; sort: { col: string; dir: 1 | -1 } | null }

function loadState(viewId: string): TState {
  try { return { order: [], widths: {}, sort: null, ...JSON.parse(localStorage.getItem(LS.table(viewId)) || '{}') }; }
  catch { return { order: [], widths: {}, sort: null }; }
}
const saveState = (viewId: string, s: TState) => localStorage.setItem(LS.table(viewId), JSON.stringify(s));

export function renderTable(opts: TableOpts): HTMLElement {
  const st = loadState(opts.viewId);
  const byId = new Map(opts.columns.map((c) => [c.id, c]));
  let cols = st.order.map((id) => byId.get(id)!).filter(Boolean);
  for (const c of opts.columns) if (!cols.includes(c)) cols.push(c);

  const section = el('div', { class: 'qam-section', style: 'display:grid;grid-template-rows:auto 1fr;min-height:0;height:100%' });
  const bulk = el('div', { class: 'qam-bulk' });
  const wrap = el('div', { class: 'qam-tablewrap' });
  const table = el('table', { class: 'qam-table' });
  wrap.append(table);
  section.append(bulk, wrap);

  const widthOf = (c: Column) => st.widths[c.id] ?? (c.id === cols[0].id ? 220 : 160);

  function updateBulk(): void {
    clear(bulk);
    const keys = [...opts.selected];
    const total = opts.rows.length;
    const note = total > MAX_ROWS ? `（全 ${total.toLocaleString()} 件中 先頭 ${MAX_ROWS} 件を表示・検索/フィルタで絞り込み）` : '';
    bulk.append(el('span', {}, [keys.length ? `${keys.length} 件選択中` : `${total.toLocaleString()} 件${note}`]));
    if (keys.length && opts.bulkActions) {
      const acts = el('div', { class: 'qam-bulk-actions' });
      opts.bulkActions(keys).forEach((b) => acts.append(b));
      bulk.append(acts);
    }
  }

  function sortedRows(): any[] {
    if (!st.sort) return opts.rows;
    const col = byId.get(st.sort.col);
    if (!col) return opts.rows;
    const val = col.sortVal ?? ((r: any) => String(col.render(r)));
    return [...opts.rows].sort((a, b) => val(a).localeCompare(val(b)) * st.sort!.dir);
  }

  function render(): void {
    clear(table);
    const colgroup = el('colgroup');
    colgroup.append(el('col', { style: 'width:38px' }));
    cols.forEach((c) => colgroup.append(el('col', { style: `width:${widthOf(c)}px` })));
    table.append(colgroup);

    // ---- thead ----
    const allKeys = opts.rows.map(opts.getKey);
    const selCount = allKeys.filter((k) => opts.selected.has(k)).length;
    const selAll = el('input', { type: 'checkbox' }) as HTMLInputElement;
    selAll.checked = selCount > 0 && selCount === allKeys.length;
    selAll.indeterminate = selCount > 0 && selCount < allKeys.length;
    selAll.addEventListener('change', () => {
      if (selAll.checked) allKeys.forEach((k) => opts.selected.add(k));
      else allKeys.forEach((k) => opts.selected.delete(k));
      render(); opts.onSelectionChange?.();
    });
    const thCheck = el('th', { class: 'qam-col-check' }); thCheck.append(selAll);
    const trH = el('tr'); trH.append(thCheck);
    cols.forEach((c) => trH.append(buildTh(c)));
    const thead = el('thead'); thead.append(trH); table.append(thead);

    // ---- tbody（大量行はフリーズするので先頭 MAX_ROWS 件のみ描画） ----
    const tbody = el('tbody');
    const allRows = sortedRows();
    for (const row of allRows.slice(0, MAX_ROWS)) {
      const key = opts.getKey(row);
      const tr = el('tr', { class: opts.selected.has(key) ? 'qam-selected' : '' });
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = opts.selected.has(key);
      cb.addEventListener('click', (e) => e.stopPropagation());
      // 行トグルは class 更新 + バルクのみ。全再描画(render)すると大量行でクリック毎に固まる。
      cb.addEventListener('change', () => { if (cb.checked) opts.selected.add(key); else opts.selected.delete(key); tr.classList.toggle('qam-selected', cb.checked); updateBulk(); opts.onSelectionChange?.(); });
      const tdC = el('td', { class: 'qam-col-check' }); tdC.append(cb); tr.append(tdC);
      cols.forEach((c) => {
        const td = el('td', { class: c.mono ? 'qam-mono' : '' });
        const v = c.render(row);
        if (typeof v === 'string') td.innerHTML = v; else td.append(v);
        td.title = td.textContent || '';
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    updateBulk();
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

  function applyWidths(): void {
    const colEls = table.querySelectorAll('colgroup col');
    cols.forEach((c, i) => { (colEls[i + 1] as HTMLElement).style.width = `${widthOf(c)}px`; });
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
