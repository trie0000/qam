import { describe, it, expect, vi } from 'vitest';
import { renderCalendar } from '../src/ui/calendar';

// クリック=単日 / Shift+クリック=範囲。pointerdown→pointerup を模擬（drag は elementFromPoint 依存のため対象外）。
const down = (cell: Element, shift = false): void => { cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, shiftKey: shift })); };
const up = (): void => { document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); };
const cell = (cal: HTMLElement, n: string): HTMLElement => [...cal.querySelectorAll('.qam-cal-day')].find((c) => c.textContent === n) as HTMLElement;

describe('calendar (範囲選択)', () => {
  it('変更日にマークを付け、クリックで単日(from=to)を返す', () => {
    const onRange = vi.fn();
    const cal = renderCalendar({ marked: new Set(['2026-06-13', '2026-06-20']), from: '', to: '', onRange });
    expect(cal.querySelectorAll('.qam-cal-day').length).toBe(30);
    expect(cal.querySelector('.qam-cal-title')?.textContent).toBe('2026年 6月');
    expect(cal.querySelectorAll('.qam-cal-marked').length).toBe(2);
    down(cell(cal, '13')); up();
    expect(onRange).toHaveBeenCalledWith('2026-06-13', '2026-06-13'); // 単日
  });

  it('Shift+クリックで開始日からの範囲を返す', () => {
    const onRange = vi.fn();
    const cal = renderCalendar({ marked: new Set(), from: '2026-06-13', to: '', onRange });
    down(cell(cal, '20'), true); up();
    expect(onRange).toHaveBeenCalledWith('2026-06-13', '2026-06-20');
  });

  it('範囲確定済みの端/範囲内ハイライト、単日クリックで開始し直す', () => {
    const onRange = vi.fn();
    const cal = renderCalendar({ marked: new Set(), from: '2026-06-13', to: '2026-06-20', onRange });
    expect(cal.querySelectorAll('.qam-cal-sel').length).toBe(2);   // 端 13/20
    expect(cal.querySelectorAll('.qam-cal-range').length).toBe(6); // 14〜19
    down(cell(cal, '10')); up();
    expect(onRange).toHaveBeenCalledWith('2026-06-10', '2026-06-10');
  });
});
