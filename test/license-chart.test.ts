import { describe, it, expect } from 'vitest';
import { fiscalYear, prepareLicenseSeries, licenseChartSvg, FY_MONTHS } from '../src/ui/license-chart';

describe('license-chart', () => {
  it('fiscalYear: 4月以降は当年度、1〜3月は前年度', () => {
    expect(fiscalYear('2026-04-01T00-00-00')).toBe(2026);
    expect(fiscalYear('2026-12-31T00-00-00')).toBe(2026);
    expect(fiscalYear('2027-03-31T00-00-00')).toBe(2026);
    expect(fiscalYear('2027-04-01T00-00-00')).toBe(2027);
  });

  it('prepareLicenseSeries: 年度ごとに 4月始まりの12ヶ月へ整列、無い月は null', () => {
    const series = prepareLicenseSeries([
      { ts: '2026-04-10T09-00-00', count: 100 },
      { ts: '2026-05-10T09-00-00', count: 110 },
      { ts: '2027-01-10T09-00-00', count: 120 }, // 1月 → 2026年度の10番目
    ]);
    expect(series.length).toBe(1);
    expect(series[0].fy).toBe(2026);
    expect(series[0].label).toBe('2026年度');
    // FY_MONTHS = [4,5,...,12,1,2,3]
    expect(series[0].months[FY_MONTHS.indexOf(4)]).toBe(100);
    expect(series[0].months[FY_MONTHS.indexOf(5)]).toBe(110);
    expect(series[0].months[FY_MONTHS.indexOf(1)]).toBe(120);
    expect(series[0].months[FY_MONTHS.indexOf(6)]).toBeNull();
  });

  it('同年度・同月に複数サンプルがあれば最新(ts最大)を採用、年度は新しい順', () => {
    const series = prepareLicenseSeries([
      { ts: '2025-04-01T09-00-00', count: 50 },
      { ts: '2026-04-01T09-00-00', count: 100 },
      { ts: '2026-04-20T18-00-00', count: 105 }, // 同月の後発 → 採用
    ]);
    expect(series.map((s) => s.fy)).toEqual([2026, 2025]);
    expect(series[0].months[FY_MONTHS.indexOf(4)]).toBe(105);
    // 色は並び順で割当（先頭が最新年度）
    expect(series[0].color).not.toBe(series[1].color);
  });

  it('licenseChartSvg: SVG を生成し、表示年度のみ折れ線を描く', () => {
    const series = prepareLicenseSeries([
      { ts: '2026-04-10T09-00-00', count: 100 },
      { ts: '2026-05-10T09-00-00', count: 110 },
      { ts: '2025-04-10T09-00-00', count: 50 },
    ]);
    const svg = licenseChartSvg(series, new Set([2026])); // 2026年度のみ表示
    expect(svg.tagName.toLowerCase()).toBe('svg');
    // 2026年度は2点(4,5月)つながるので polyline 1本＋点2つ
    expect(svg.querySelectorAll('polyline').length).toBe(1);
    expect(svg.querySelectorAll('circle').length).toBe(2);
    // 月ラベル 12 個
    const labels = [...svg.querySelectorAll('text')].map((t) => t.textContent);
    for (const m of FY_MONTHS) expect(labels).toContain(`${m}月`);
  });

  it('licenseChartSvg: limit>0 で上限の破線とラベルを描く', () => {
    const series = prepareLicenseSeries([{ ts: '2026-04-10T09-00-00', count: 100 }]);
    const withLimit = licenseChartSvg(series, new Set([2026]), 500);
    expect(withLimit.querySelector('.qam-lic-limit')).toBeTruthy();
    const lbl = [...withLimit.querySelectorAll('text')].map((t) => t.textContent);
    expect(lbl).toContain('IPs in Subscription 500');
    // limit=0 なら上限線なし
    const noLimit = licenseChartSvg(series, new Set([2026]), 0);
    expect(noLimit.querySelector('.qam-lic-limit')).toBeNull();
  });
});
