// 既存の変更履歴（手運用の CSV）を QamEvent に変換して取り込む。entity ごとにヘッダ仕様を持つ。
// 列はヘッダ名（キーワード）で対応付けるので順序は不問。表示は変更履歴ビューの
// 更新日 / 種別 / ID / 名前 / 項目 / 変更後 列。履歴に専用列が無い属性は「変更後」に併記して保持。
import type { QamChange, QamEntity, QamEvent } from '../types';

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

function normDate(s: string): string {
  const m = s.trim().match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const m2 = s.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m2 ? m2[1] : '';
}

function inferChange(content: string): QamChange {
  if (/削除|廃止|除却|抹消|停止/.test(content)) return 'deleted';
  if (/追加|新規|登録|新設|開設/.test(content)) return 'added';
  return 'modified';
}

// entity ごとの列仕様。id/name は候補正規表現の先頭から非空値を採用。
interface HistSpec {
  date: RegExp;
  content: RegExp | null;          // 本文に使う列（更新内容 / host はメモ）。
  field: string;                   // 「項目」列の表示ラベル。
  id: RegExp[];
  name: RegExp[];
  extras: [string, RegExp][];      // [併記ラベル, ヘッダ正規表現]
}
const SPECS: Record<QamEntity, HistSpec> = {
  group: {
    date: /更新日/, content: /更新内容/, field: '更新内容',
    id: [/接続点ID/i, /タイトル/], name: [/タイトル/],
    extras: [['事業場', /事業/], ['Function', /Function|機能|接続.*名称/i], ['Location', /Location|拠点/i], ['コメント', /comment|コメント/i]],
  },
  domain: {
    date: /更新日/, content: /更新内容/, field: '更新内容',
    id: [/接続点ID/i, /ドメイン名/], name: [/ドメイン名/, /接続点ID/i],
    extras: [['事業場', /事業/], ['IP範囲from', /from/i], ['IP範囲to', /to/i], ['外接番号', /外接/]],
  },
  host: {
    date: /更新日/, content: /メモ/, field: 'メモ',
    id: [/外接/, /FQDN/i], name: [/FQDN/i, /接続[店点]名/],
    extras: [['接続点名', /接続[店点]名/], ['IP', /IP|アドレス/i]],
  },
  user: {
    date: /更新日/, content: /更新内容/, field: '更新内容',
    id: [/アカウント名/, /接続点ID/i], name: [/氏名/, /アカウント名/],
    extras: [['接続点ID', /接続点ID/i], ['姓', /姓/], ['名', /名前/], ['事業場', /事業/], ['TEL', /TEL|電話/i],
      ['Email', /mail|メール/i], ['Language', /Language|言語/i], ['権限', /権限|role/i],
      ['ログイン方法', /ログイン方法|SAML/i], ['スキャン結果通知', /スキャン|通知/]],
  },
};

export function parseHistoryCsv(entity: QamEntity, text: string): QamEvent[] {
  const spec = SPECS[entity];
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) throw new Error('CSV が空です');
  const header = rows[0].map((h) => h.trim());
  const idx = (re: RegExp): number => header.findIndex((h) => re.test(h));
  const dateI = idx(spec.date);
  if (dateI < 0) throw new Error('ヘッダに「更新日」が必要です');
  const contentI = spec.content ? idx(spec.content) : -1;
  const idIdx = spec.id.map(idx).filter((i) => i >= 0);
  const nameIdx = spec.name.map(idx).filter((i) => i >= 0);
  const extraDefs = spec.extras.map(([label, re]) => [label, idx(re)] as [string, number]).filter(([, i]) => i >= 0);

  const events: QamEvent[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (j: number): string => (j >= 0 ? (r[j] ?? '').trim() : '');
    const date = normDate(get(dateI));
    const id = idIdx.map(get).find((v) => v) || '';
    if (!date || !id) return; // 更新日・識別子が無い行はスキップ
    const name = nameIdx.map(get).find((v) => v) || id;
    const content = get(contentI);
    const extras = extraDefs.map(([label, j]) => [label, get(j)] as [string, string])
      .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
    events.push({
      eid: `${entity}:${id}:${date}:import:${i}`,
      ts: `${date}T00-00-00`,
      entity, id, name,
      change: inferChange(content || extras.join(' ')),
      field: spec.field,
      old: '',
      new: [content, ...extras].filter(Boolean).join(' / '),
    });
  });
  if (!events.length) throw new Error('取り込める行がありません（更新日・識別子列を確認してください）');
  return events;
}

// 既存呼び出し/テスト用の薄いラッパ。
export const parseGroupHistoryCsv = (text: string): QamEvent[] => parseHistoryCsv('group', text);

// 取込モーダルに表示する各 entity の想定ヘッダ。
export const HIST_HEADER_HINT: Record<QamEntity, string> = {
  group: '更新日, 更新内容, 接続点ID, 事業場名, タイトル, 接続点名称(Function), 拠点名称(Location), コメント(comments)',
  domain: '更新日, 更新内容, 接続点ID, 事業場名, ドメイン名, IPアドレス範囲_from, IPアドレス範囲_to, 外接番号',
  host: '更新日, 接続点名, IPアドレス, FQDN, メモ, 外接番号',
  user: '更新日, 更新内容, 接続点ID, 氏名, 名前, 姓, 事業場名, TEL, e_mail, アカウント名, Language, 権限, ログイン方法(SAML), スキャン結果通知',
};
