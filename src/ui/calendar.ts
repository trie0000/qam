// 月カレンダー: 変更があった日を薄い赤の丸で表示。クリックで単日、ドラッグ or Shift+クリックで範囲選択。
import { el, clear } from './dom';
import { icon } from '../icons';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface CalendarOpts {
  marked: Set<string>;               // 変更があった 'YYYY-MM-DD'
  from: string;                      // 範囲開始 'YYYY-MM-DD'（''=未選択）
  to: string;                        // 範囲終了
  onRange: (from: string, to: string) => void; // ''/'' で解除
}

export function renderCalendar(opts: CalendarOpts): HTMLElement {
  const root = el('div', { class: 'qam-cal' });
  const base = opts.from || [...opts.marked].sort().pop() || ymd(new Date());
  const view = new Date(base + 'T00:00:00');
  view.setDate(1);

  function draw(): void {
    clear(root);
    const prev = el('button', { class: 'btn btn--icon', 'aria-label': '前の月', html: icon('chevronLeft', 16) });
    const next = el('button', { class: 'btn btn--icon', 'aria-label': '次の月', html: icon('chevronRight', 16) });
    prev.addEventListener('click', () => { view.setMonth(view.getMonth() - 1); draw(); });
    next.addEventListener('click', () => { view.setMonth(view.getMonth() + 1); draw(); });
    root.append(el('div', { class: 'qam-cal-head' }, [prev, el('span', { class: 'qam-cal-title' }, [`${view.getFullYear()}年 ${view.getMonth() + 1}月`]), next]));

    const grid = el('div', { class: 'qam-cal-grid' });
    WD.forEach((w) => grid.append(el('div', { class: 'qam-cal-wd' }, [w])));
    for (let i = 0; i < view.getDay(); i++) grid.append(el('div', {}));
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const cells: HTMLElement[] = [];
    for (let d = 1; d <= days; d++) {
      const day = `${view.getFullYear()}-${pad(view.getMonth() + 1)}-${pad(d)}`;
      const cls = ['qam-cal-day'];
      if (opts.marked.has(day)) cls.push('qam-cal-marked');
      const isEnd = day === opts.from || day === opts.to;
      const inRange = opts.from && opts.to && day >= opts.from && day <= opts.to;
      if (isEnd) cls.push('qam-cal-sel');
      else if (inRange) cls.push('qam-cal-range');
      const cell = el('button', { class: cls.join(' '), dataset: { day }, title: opts.marked.has(day) ? '変更あり' : '' }, [String(d)]);
      cells.push(cell); grid.append(cell);
    }
    root.append(grid);
    attachSelect(grid, cells);

    const hint = opts.from
      ? (opts.to && opts.to !== opts.from ? `${opts.from} 〜 ${opts.to}` : `${opts.from}`)
      : 'クリックで単日 / ドラッグ・Shift+クリックで範囲';
    root.append(el('div', { class: 'qam-cal-hint' }, [hint]));
    const all = el('button', { class: 'btn btn--sm btn--ghost qam-cal-all' }, ['すべて表示']);
    all.addEventListener('click', () => opts.onRange('', ''));
    root.append(all);
  }

  // クリック=単日 / ドラッグ=範囲 / Shift+クリック=（既存開始日があれば）その範囲。
  function attachSelect(grid: HTMLElement, cells: HTMLElement[]): void {
    const dayAt = (x: number, y: number): string | null => {
      const e = document.elementFromPoint(x, y) as HTMLElement | null;
      const c = e?.closest('.qam-cal-day[data-day]') as HTMLElement | null;
      return c ? c.dataset.day ?? null : null;
    };
    const preview = (a: string, b: string): void => {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      cells.forEach((c) => { const dd = c.dataset.day!; c.classList.toggle('qam-cal-preview', dd >= lo && dd <= hi); });
    };
    grid.addEventListener('pointerdown', (e) => {
      const c = (e.target as HTMLElement).closest('.qam-cal-day[data-day]') as HTMLElement | null;
      if (!c) return;
      e.preventDefault();
      const startDay = c.dataset.day!; let lastDay = startDay; let dragging = false; const shift = e.shiftKey;
      const move = (ev: PointerEvent): void => {
        const d = dayAt(ev.clientX, ev.clientY);
        if (d) { lastDay = d; if (d !== startDay) dragging = true; preview(startDay, lastDay); }
      };
      const up = (): void => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        cells.forEach((cc) => cc.classList.remove('qam-cal-preview'));
        if (dragging && lastDay !== startDay) {
          opts.onRange(startDay < lastDay ? startDay : lastDay, startDay < lastDay ? lastDay : startDay);
        } else if (shift && opts.from) {
          const a = opts.from;
          opts.onRange(a < startDay ? a : startDay, a < startDay ? startDay : a);
        } else {
          opts.onRange(startDay, startDay); // 単日
        }
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
  }

  draw();
  return root;
}
