// 月カレンダー: 変更があった日に印。クリックで範囲(from→to)選択（再クリックで単日に戻る）。
import { el, clear } from './dom';
import { icon } from '../icons';

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface CalendarOpts {
  marked: Set<string>;               // 変更があった 'YYYY-MM-DD'
  from: string;                      // 範囲開始 'YYYY-MM-DD'（''=未選択）
  to: string;                        // 範囲終了（''=単日 or 未選択）
  onRange: (from: string, to: string) => void; // ''/'' で解除
}

export function renderCalendar(opts: CalendarOpts): HTMLElement {
  const root = el('div', { class: 'qam-cal' });
  const base = opts.from || [...opts.marked].sort().pop() || ymd(new Date());
  const view = new Date(base + 'T00:00:00');
  view.setDate(1);

  // クリック規則: 範囲確定済み or 未選択 → 新規開始 / 開始のみ → 終了確定（前なら開始差替え）
  function pick(day: string): void {
    if (!opts.from || (opts.from && opts.to)) opts.onRange(day, '');
    else if (day >= opts.from) opts.onRange(opts.from, day);
    else opts.onRange(day, '');
  }

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
      const isEnd = day === opts.from || day === opts.to;
      const inRange = opts.from && opts.to && day >= opts.from && day <= opts.to;
      if (isEnd) cls.push('qam-cal-sel');
      else if (inRange) cls.push('qam-cal-range');
      const cell = el('button', { class: cls.join(' '), title: opts.marked.has(day) ? '変更あり' : '' }, [String(d)]);
      cell.addEventListener('click', () => pick(day));
      grid.append(cell);
    }
    root.append(grid);
    const hint = opts.from ? (opts.to ? `${opts.from} 〜 ${opts.to}` : `${opts.from}（終了日をクリックで範囲指定）`) : '日をクリックで絞り込み';
    root.append(el('div', { class: 'qam-cal-hint' }, [hint]));
    const all = el('button', { class: 'btn btn--sm btn--ghost qam-cal-all' }, ['すべて表示']);
    all.addEventListener('click', () => opts.onRange('', ''));
    root.append(all);
  }
  draw();
  return root;
}
