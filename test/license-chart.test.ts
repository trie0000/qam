import { describe, it, expect } from 'vitest';
import { fiscalYear, prepareLicenseSeries, licenseChartSvg, FY_MONTHS, type LicenseSample } from '../src/ui/license-chart';

// テスト用サンプル生成（ips/scanned を同値で簡略化、必要なら個別指定）。
const s = (ts: string, ips: number, scanned = ips): LicenseSample => ({ ts, ips, scanned });

describe('license-chart', () => {
  it('fiscalYear: 4月以降は当年度、1〜3月は前年度', () => {
    expect(fiscalYear('2026-04-01T00-00-00')).toBe(2026);
    expect(fiscalYear('2026-12-31T00-00-00')).toBe(2026);
    expect(fiscalYear('2027-03-31T00-00-00')).toBe(2026);
    expect(fiscalYear('2027-04-01T00-00-00')).toBe(2027);
  });

  it('prepareLicenseSeries: 年度ごとに 4月始まりの12ヶ月へ整列、無い月は null。指標で値を切替', () => {
    const samples = [s('2026-04-10T09-00-00', 100, 80), s('2026-05-10T09-00-00', 110, 90), s('2027-01-10T09-00-00', 120, 95)];
    const ips = prepareLicenseSeries(samples, 'ips');
    expect(ips.length).toBe(1);
    expect(ips[0].fy).toBe(2026);
    expect(ips[0].months[FY_MONTHS.indexOf(4)]).toBe(100);
    expect(ips[0].months[FY_MONTHS.indexOf(1)]).toBe(120);
    expect(ips[0].months[FY_MONTHS.indexOf(6)]).toBeNull();
    // scanned 指標では scanned 値を使う
    const scanned = prepareLicenseSeries(samples, 'scanned');
    expect(scanned[0].months[FY_MONTHS.indexOf(4)]).toBe(80);
    expect(scanned[0].months[FY_MONTHS.indexOf(5)]).toBe(90);
  });

  it('同年度・同月に複数サンプルがあれば最新(ts最大)を採用、年度は新しい順', () => {
    const series = prepareLicenseSeries([s('2025-04-01T09-00-00', 50), s('2026-04-01T09-00-00', 100), s('2026-04-20T18-00-00', 105)], 'ips');
    expect(series.map((x) => x.fy)).toEqual([2026, 2025]);
    expect(series[0].months[FY_MONTHS.indexOf(4)]).toBe(105);
    expect(series[0].color).not.toBe(series[1].color);
  });

  it('licenseChartSvg: SVG を生成し、表示年度のみ折れ線を描く', () => {
    const series = prepareLicenseSeries([s('2026-04-10T09-00-00', 100), s('2026-05-10T09-00-00', 110), s('2025-04-10T09-00-00', 50)], 'ips');
    const svg = licenseChartSvg(series, new Set([2026]));
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelectorAll('polyline').length).toBe(1);
    expect(svg.querySelectorAll('circle').length).toBe(2);
    const labels = [...svg.querySelectorAll('text')].map((t) => t.textContent);
    for (const m of FY_MONTHS) expect(labels).toContain(`${m}月`);
  });

  it('licenseChartSvg: limit>0 で Purchased IPs の破線とラベルを描く', () => {
    const series = prepareLicenseSeries([s('2026-04-10T09-00-00', 100)], 'ips');
    const withLimit = licenseChartSvg(series, new Set([2026]), 500);
    expect(withLimit.querySelector('.qam-lic-limit')).toBeTruthy();
    const lbl = [...withLimit.querySelectorAll('text')].map((t) => t.textContent);
    expect(lbl).toContain('Purchased IPs 500');
    const noLimit = licenseChartSvg(series, new Set([2026]), 0);
    expect(noLimit.querySelector('.qam-lic-limit')).toBeNull();
  });
});
