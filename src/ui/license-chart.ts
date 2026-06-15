// ライセンス数推移グラフ: 年度（4月〜翌3月）ごとの折れ線を 12 ヶ月の x 軸に重ねて描く。
// データの無い月は未記載（点を打たず線を分断）。色は年度の並び順で固定。
import { el } from './dom';

export interface LicenseSample { ts: string; ips: number; scanned: number }

// 年度の x 軸（4月始まり〜翌3月）。
export const FY_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];

// 折れ線の色（年度の並び順＝新しい年度から割当）。テーマに依らず読める固定色。
export const FY_COLORS = ['#5e6f5c', '#b8534a', '#3f72a6', '#c47f1c', '#7a5ca6', '#2f8f6e', '#a6486f', '#6b7a8f'];

// 取込stamp/ISO の先頭 'YYYY-MM' から年度を求める（1〜3月は前年度）。
export function fiscalYear(ts: string): number {
  const y = parseInt(ts.slice(0, 4), 10);
  const m = parseInt(ts.slice(5, 7), 10);
  return m >= 4 ? y : y - 1;
}

export interface FySeries { fy: number; label: string; color: string; months: (number | null)[] }

// サンプル群 → 年度ごとの系列（新しい年度順）。同じ年度・同じ月に複数サンプルがあれば ts 最大（最新）を採用。
// months は FY_MONTHS と同じ並び（4月→翌3月）の 12 要素。データ無しは null。
export function prepareLicenseSeries(samples: LicenseSample[]): FySeries[] {
  // (fy, month) ごとの最新サンプル
  const latest = new Map<string, LicenseSample>();
  for (const s of samples) {
    if (!s || !s.ts) continue;
    const fy = fiscalYear(s.ts);
    const m = parseInt(s.ts.slice(5, 7), 10);
    if (!(m >= 1 && m <= 12)) continue;
    const key = `${fy}:${m}`;
    const cur = latest.get(key);
    if (!cur || s.ts > cur.ts) latest.set(key, s);
  }
  const fys = [...new Set([...latest.keys()].map((k) => parseInt(k.split(':')[0], 10)))].sort((a, b) => b - a);
  return fys.map((fy, i) => ({
    fy,
    label: `${fy}年度`,
    color: FY_COLORS[i % FY_COLORS.length],
    months: FY_MONTHS.map((m) => { const s = latest.get(`${fy}:${m}`); return s ? s.scanned : null; }),
  }));
}

// 目盛り上限を「きりのよい値」に丸める。
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// 表示する系列（visible）から SVG を生成。x=12ヶ月固定、y=0〜きりのよい上限。点はデータのある月のみ。
// limit>0 ならライセンス数上限の横線を引く（y 上限にも反映して線が必ず見えるようにする）。
export function licenseChartSvg(series: FySeries[], visibleFy: Set<number>, limit = 0): SVGElement {
  const W = 760; const H = 360; const padL = 52; const padR = 16; const padT = 16; const padB = 40;
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const visible = series.filter((s) => visibleFy.has(s.fy));
  const maxVal = Math.max(1, limit > 0 ? limit : 0, ...visible.flatMap((s) => s.months.filter((v): v is number => v != null)));
  const yMax = niceMax(maxVal);
  const x = (i: number): number => padL + (plotW * i) / (FY_MONTHS.length - 1);
  const y = (v: number): number => padT + plotH * (1 - v / yMax);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'qam-lic-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const add = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const e = document.createElementNS(ns, tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    if (text != null) e.textContent = text;
    svg.append(e); return e as SVGElement;
  };

  // y 軸グリッド＋目盛り（5 分割）
  const TICKS = 5;
  for (let t = 0; t <= TICKS; t++) {
    const val = (yMax * t) / TICKS; const yy = y(val);
    add('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, class: 'qam-lic-grid' });
    add('text', { x: padL - 8, y: yy + 4, class: 'qam-lic-axislbl', 'text-anchor': 'end' }, String(Math.round(val)));
  }
  // x 軸ラベル（月）
  FY_MONTHS.forEach((m, i) => add('text', { x: x(i), y: H - padB + 20, class: 'qam-lic-axislbl', 'text-anchor': 'middle' }, `${m}月`));

  // IPs in Subscription（契約IP数）の横線（破線）＋ラベル
  if (limit > 0) {
    const yy = y(limit);
    add('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, class: 'qam-lic-limit' });
    add('text', { x: W - padR, y: yy - 5, class: 'qam-lic-limitlbl', 'text-anchor': 'end' }, `ライセンス上限 ${limit.toLocaleString()}`);
  }

  // 系列（データの無い月で線を分断。点はデータのある月のみ）
  for (const s of visible) {
    let seg: string[] = [];
    const flush = (): void => {
      if (seg.length >= 2) add('polyline', { points: seg.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      seg = [];
    };
    s.months.forEach((v, i) => { if (v == null) { flush(); } else { seg.push(`${x(i)},${y(v)}`); } });
    flush();
    s.months.forEach((v, i) => { if (v != null) { const c = add('circle', { cx: x(i), cy: y(v), r: 3, fill: s.color }) as SVGElement; c.append(document.createElementNS(ns, 'title')); (c.lastChild as Element).textContent = `${s.label} ${FY_MONTHS[i]}月: ${v}`; } });
  }
  return svg as unknown as SVGElement;
}
