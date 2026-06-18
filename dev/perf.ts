// 大量行スクロール検証用ハーネス（relay 不要。table 単体を実ブラウザで確認する）。
import css from '../src/styles/app.css';
import { renderTable, type Column } from '../src/ui/table';

const style = document.createElement('style'); style.textContent = css; document.head.append(style);
document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.fontsize = 'md';

const N = 15000;
const rows = Array.from({ length: N }, (_, i) => ({ id: String(i), ts: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, name: 'row ' + i, val: 'value ' + i }));
const cols: Column[] = [
  { id: 'ts', label: '更新日', mono: true, render: (r: any) => r.ts, sortVal: (r: any) => r.ts },
  { id: 'name', label: '名前', render: (r: any) => r.name },
  { id: 'val', label: '値', render: (r: any) => r.val },
];

const host = document.createElement('div');
host.id = 'host';
host.style.cssText = 'height:520px;display:flex;flex-direction:column;border:1px solid #ccc';
document.body.append(host);
const t0 = performance.now();
host.append(renderTable({ viewId: 'perf', columns: cols, rows, getKey: (r: any) => r.id, selected: new Set<string>() }));
(window as any).__renderMs = Math.round(performance.now() - t0);
