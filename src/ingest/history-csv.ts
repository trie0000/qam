// 既存の変更履歴（手運用の CSV）を QamEvent に変換して取り込む。まずは AssetGroup のみ。
// AssetGroup CSV ヘッダ（列順は問わず・ヘッダ名で対応付け）:
//   更新日, 更新内容, 接続点ID, 事業場名, タイトル, 接続点名称(Function), 拠点名称(Location), コメント(comments)
import type { QamChange, QamEvent } from '../types';

// RFC4180 風 CSV パーサ（ダブルクォート・改行・カンマ対応）。
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* CRLF の CR は無視 */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 更新日を yyyy-MM-dd へ正規化（'2026/6/1' '2026.06.01' '2026-06-01' 等）。
function normDate(s: string): string {
  const m = s.trim().match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const m2 = s.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m2 ? m2[1] : '';
}

// 更新内容の語から種別を推定（不明は modified）。
function inferChange(content: string): QamChange {
  if (/削除|廃止|除却|抹消|停止/.test(content)) return 'deleted';
  if (/追加|新規|登録|新設|開設/.test(content)) return 'added';
  return 'modified';
}

export function parseGroupHistoryCsv(text: string): QamEvent[] {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) throw new Error('CSV が空です');
  const header = rows[0].map((h) => h.trim());
  const find = (re: RegExp): number => header.findIndex((h) => re.test(h));
  const col = {
    date: find(/更新日/),
    content: find(/更新内容/),
    setten: find(/接続点ID/i),
    division: find(/事業場/),
    title: find(/タイトル/),
    func: find(/Function|機能|接続点名称/i),
    loc: find(/Location|拠点/i),
    comments: find(/comment|コメント/i),
  };
  if (col.date < 0 || col.content < 0) throw new Error('ヘッダに「更新日」「更新内容」が必要です');

  const events: QamEvent[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (idx: number): string => (idx >= 0 ? (r[idx] ?? '').trim() : '');
    const date = normDate(get(col.date));
    const content = get(col.content);
    const id = get(col.setten) || get(col.title);
    if (!date || !id) return; // 日付・識別子が無い行はスキップ
    // 履歴列に無い属性（事業場/Function/Location/コメント）は変更内容に併記して保持。
    const extras = ([
      ['事業場', get(col.division)], ['Function', get(col.func)],
      ['Location', get(col.loc)], ['コメント', get(col.comments)],
    ] as [string, string][]).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
    events.push({
      eid: `group:${id}:${date}:import:${i}`,
      ts: `${date}T00-00-00`,
      entity: 'group',
      id,
      name: get(col.title) || id,
      change: inferChange(content),
      field: '更新内容',
      old: '',
      new: [content, ...extras].filter(Boolean).join(' / '),
    });
  });
  if (!events.length) throw new Error('取り込める行がありません（更新日・接続点ID/タイトルを確認してください）');
  return events;
}
