import { describe, it, expect, vi } from 'vitest';
import { renderCalendar } from '../src/ui/calendar';

describe('calendar', () => {
  it('変更日にマークを付け、クリックでその日を返す', () => {
    const onSelect = vi.fn();
    const cal = renderCalendar({ marked: new Set(['2026-06-13', '2026-06-20']), selected: '', onSelect });

    // 6月(30日)＋曜日オフセットぶんの空セル
    const dayCells = cal.querySelectorAll('.qam-cal-day');
    expect(dayCells.length).toBe(30);
    expect(cal.querySelector('.qam-cal-title')?.textContent).toBe('2026年 6月');

    // マークされた日が2つ
    expect(cal.querySelectorAll('.qam-cal-marked').length).toBe(2);

    // 13日をクリック → onSelect('2026-06-13')
    const d13 = [...dayCells].find((c) => c.textContent === '13') as HTMLElement;
    d13.click();
    expect(onSelect).toHaveBeenCalledWith('2026-06-13');
  });

  it('選択中の日を再クリックすると解除（空文字）', () => {
    const onSelect = vi.fn();
    const cal = renderCalendar({ marked: new Set(['2026-06-13']), selected: '2026-06-13', onSelect });
    expect(cal.querySelector('.qam-cal-sel')?.textContent).toBe('13');
    (cal.querySelector('.qam-cal-sel') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('');
  });
});
