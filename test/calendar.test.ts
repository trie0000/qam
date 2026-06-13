import { describe, it, expect, vi } from 'vitest';
import { renderCalendar } from '../src/ui/calendar';

describe('calendar (範囲選択)', () => {
  it('変更日にマークを付け、クリックで開始日を返す', () => {
    const onRange = vi.fn();
    const cal = renderCalendar({ marked: new Set(['2026-06-13', '2026-06-20']), from: '', to: '', onRange });
    const dayCells = cal.querySelectorAll('.qam-cal-day');
    expect(dayCells.length).toBe(30);
    expect(cal.querySelector('.qam-cal-title')?.textContent).toBe('2026年 6月');
    expect(cal.querySelectorAll('.qam-cal-marked').length).toBe(2);
    const d13 = [...dayCells].find((c) => c.textContent === '13') as HTMLElement;
    d13.click();
    expect(onRange).toHaveBeenCalledWith('2026-06-13', '');
  });

  it('開始日があるとき後の日をクリックで from〜to 範囲', () => {
    const onRange = vi.fn();
    const cal = renderCalendar({ marked: new Set(), from: '2026-06-13', to: '', onRange });
    const d20 = [...cal.querySelectorAll('.qam-cal-day')].find((c) => c.textContent === '20') as HTMLElement;
    d20.click();
    expect(onRange).toHaveBeenCalledWith('2026-06-13', '2026-06-20');
  });

  it('範囲確定済みで再クリックすると新規開始', () => {
    const onRange = vi.fn();
    const cal = renderCalendar({ marked: new Set(), from: '2026-06-13', to: '2026-06-20', onRange });
    // 範囲内/端のハイライト
    expect(cal.querySelectorAll('.qam-cal-sel').length).toBe(2);
    expect(cal.querySelectorAll('.qam-cal-range').length).toBe(6); // 14〜19
    const d10 = [...cal.querySelectorAll('.qam-cal-day')].find((c) => c.textContent === '10') as HTMLElement;
    d10.click();
    expect(onRange).toHaveBeenCalledWith('2026-06-10', '');
  });
});
