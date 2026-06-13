// 月カレンダー: 変更があった日に印を付け、クリックでその日を選択（再クリック/「すべて」で解除）。
import { el, clear } from './dom';
import { icon } from '../icons';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface CalendarOpts {
  marked: Set<string>;            // 変更があった 'YYYY-MM-DD'
  selected: string;               // 選択中 'YYYY-MM-DD'（''=未選択）
  onSelect: (day: string) => void; // ''=解除
}

export function renderCalendar(opts: CalendarOpts): HTMLElement {
  const root = el('div', { class: 'qam-cal' });
  // 初期表示月: 選択日 > 最新の変更日 > 今月
  const base = opts.selected || [...opts.marked].sort().pop() || ymd(new Date());
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
    for (let d = 1; d <= days; d++) {
      const day = `${view.getFullYear()}-${pad(view.getMonth() + 1)}-${pad(d)}`;
      const cls = ['qam-cal-day'];
      if (opts.marked.has(day)) cls.push('qam-cal-marked');
      if (opts.selected === day) cls.push('qam-cal-sel');
      const cell = el('button', { class: cls.join(' '), title: opts.marked.has(day) ? '変更あり' : '' }, [String(d)]);
      cell.addEventListener('click', () => opts.onSelect(opts.selected === day ? '' : day));
      grid.append(cell);
    }
    root.append(grid);
    const all = el('button', { class: 'btn btn--sm btn--ghost qam-cal-all' }, ['すべて表示']);
    all.addEventListener('click', () => opts.onSelect(''));
    root.append(all);
  }
  draw();
  return root;
}
