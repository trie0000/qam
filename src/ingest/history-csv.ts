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

// CSV の「変更種別」列の値を QamChange に対応付け（不明は null）。
function mapChange(v: string): QamChange | null {
  const s = v.trim();
  if (!s) return null;
  if (/^add|追加|新規|登録|新設|開設/i.test(s)) return 'added';
  if (/^del|削除|廃止|除却|抹消|停止/i.test(s)) return 'deleted';
  if (/^mod|変更|更新|修正/i.test(s)) return 'modified';
  return null;
}

// entity ごとの列仕様。
// keyCols: その値を resolveId() で現スナップショットの Qualys ID に解決し、ID 列にする
//   （AssetGroup=タイトル / Host=FQDN / Domain=ドメイン名 / User=アカウント名）。
// keyIsIdentity: keyCols の値が Qualys キーそのものか。
//   domain(ドメイン名)・user(アカウント名)は true＝キー自体なので未解決でもそのまま ID にする。
//   group(タイトル)・host(FQDN)は false＝Qualys ID(数値)とは別の表示名。CSV に ID 列は無いので、
//   未解決のときに表示名を ID に流用しない（ID は空のまま。表示名は「名前」列に残る）。
interface HistSpec {
  date: RegExp;
  type: RegExp;                    // 変更種別の列（その値で 種別 を決める。無ければ content から推定）。
  content: RegExp | null;          // 本文に使う列（更新内容 / host はメモ）。
  keyCols: RegExp[];               // Qualys ID へ解決する識別名（タイトル/FQDN/ドメイン名/アカウント名）。
  keyIsIdentity: boolean;          // keyCols の値が Qualys キー自体か（true なら未解決でも ID に採用）。
  name: RegExp[];                  // 表示名。
  extras: [string, RegExp][];      // [併記ラベル, ヘッダ正規表現]
}
const SPECS: Record<QamEntity, HistSpec> = {
  // AssetGroup: 更新日, 変更種別, 接続点ID, 事業場名(Division), タイトル, 接続名称(Function), 拠点名称(Location), メモ
  group: {
    date: /更新日/, type: /種別/, content: /メモ|更新内容/,
    keyCols: [/タイトル/], keyIsIdentity: false, name: [/タイトル/],
    extras: [['接続点ID', /接続点ID/i], ['事業場', /事業/], ['Function', /Function|機能|接続.*名称/i], ['Location', /Location|拠点/i]],
  },
  // Domain: 更新日, 変更種別, 接続点ID, ドメイン名, IP_from, IP_to（IP_from/to は同日でレンジ統合＝専用処理）
  domain: {
    date: /更新日/, type: /種別/, content: null,
    keyCols: [/ドメイン名/], keyIsIdentity: true, name: [/ドメイン名/],
    extras: [['接続点ID', /接続点ID/i]],
  },
  // Host: 更新日, 変更種別, 接続点ID, IPアドレス, FQDN（FQDN の http(s):// は除去）
  host: {
    date: /更新日/, type: /種別/, content: null,
    keyCols: [/FQDN/i], keyIsIdentity: false, name: [/FQDN/i],
    extras: [['接続点ID', /接続点ID/i], ['IP', /IPアドレス|IP|アドレス/i]],
  },
  user: {
    date: /更新日/, type: /種別/, content: /更新内容/,
    keyCols: [/アカウント名/], keyIsIdentity: true, name: [/氏名/, /アカウント名/],
    extras: [['接続点ID', /接続点ID/i], ['姓', /姓/], ['名', /名前/], ['事業場', /事業/], ['TEL', /TEL|電話/i],
      ['Email', /mail|メール/i], ['Language', /Language|言語/i], ['権限', /権限|role/i],
      ['ログイン方法', /ログイン方法|SAML/i], ['スキャン結果通知', /スキャン|通知/]],
  },
};

// FQDN 等から先頭の http:// https:// と末尾スラッシュを除去。
const stripProtocol = (s: string): string => s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

// IPv4 → 整数（不正は null）。
function ipToInt(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const ipToStr = (n: number): string => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// 同日のIP範囲(from,to)群を統合: 連続/重複する範囲はレンジにまとめ、まとめられないものは併記。
// IPv4 として解釈できないものは原文のまま併記。結果は "a-b, c, d-e" のカンマ区切り。
function consolidateRanges(pairs: [string, string][]): string {
  const valid: [number, number][] = [];
  const raw: string[] = [];
  for (const [f, t] of pairs) {
    const fromS = (f || '').trim(); const toS = (t || '').trim();
    if (!fromS && !toS) continue;
    const fi = ipToInt(fromS); const ti = ipToInt(toS || fromS);
    if (fi !== null && ti !== null) valid.push([Math.min(fi, ti), Math.max(fi, ti)]);
    else raw.push(toS && toS !== fromS ? `${fromS}-${toS}` : (fromS || toS));
  }
  valid.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [fi, ti] of valid) {
    const last = merged[merged.length - 1];
    if (last && fi <= last[1] + 1) last[1] = Math.max(last[1], ti); // 連続/重複は結合
    else merged.push([fi, ti]);
  }
  const out = merged.map(([a, b]) => (a === b ? ipToStr(a) : `${ipToStr(a)}-${ipToStr(b)}`));
  for (const r of raw) if (!out.includes(r)) out.push(r);
  return out.join(', ');
}

// resolveId: 識別名(タイトル等) → 現スナップショットの Qualys ID。未解決は '' を返す。
export function parseHistoryCsv(entity: QamEntity, text: string, resolveId: (rawName: string) => string = () => ''): QamEvent[] {
  const spec = SPECS[entity];
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) throw new Error('CSV が空です');
  const header = rows[0].map((h) => h.trim());
  const idx = (re: RegExp): number => header.findIndex((h) => re.test(h));
  const dateI = idx(spec.date);
  if (dateI < 0) throw new Error('ヘッダに「更新日」が必要です');
  const contentI = spec.content ? idx(spec.content) : -1;
  const typeI = idx(spec.type);
  const keyIdx = spec.keyCols.map(idx).filter((i) => i >= 0);
  const nameIdx = spec.name.map(idx).filter((i) => i >= 0);
  const extraDefs = spec.extras.map(([label, re]) => [label, idx(re)] as [string, number]).filter(([, i]) => i >= 0);
  const marker = 'CSVインポートで登録';

  // domain は IP_from/IP_to を「同日・同ドメイン・同種別」で1レコードに集約し、IP範囲を統合する。
  if (entity === 'domain') {
    const fromI = idx(/from/i); const toI = idx(/to/i); const sidI = idx(/接続点ID/i);
    interface DG { date: string; change: QamChange; id: string; name: string; sid: string; pairs: [string, string][] }
    const groups = new Map<string, DG>();
    for (const r of rows.slice(1)) {
      const get = (j: number): string => (j >= 0 ? (r[j] ?? '').trim() : '');
      const date = normDate(get(dateI));
      const rawKey = keyIdx.map(get).find((v) => v) || '';
      if (!date || !rawKey) continue;
      const id = resolveId(rawKey) || rawKey; // domain はドメイン名がキー
      const change = mapChange(get(typeI)) ?? inferChange('');
      const key = `${date}|${id}|${change}`;
      const g = groups.get(key) ?? { date, change, id, name: rawKey, sid: get(sidI), pairs: [] };
      if (!g.sid) g.sid = get(sidI);
      g.pairs.push([get(fromI), get(toI)]);
      groups.set(key, g);
    }
    const events: QamEvent[] = [];
    let i = 0;
    for (const g of groups.values()) {
      const ranges = consolidateRanges(g.pairs);
      // IP範囲は追加/削除IP列(props NETBLOCK)で表示するため、変更後テキストには入れない（接続点IDのみ）。
      const extras = [g.sid ? `接続点ID:${g.sid}` : ''].filter(Boolean);
      // props に NETBLOCK(=IP範囲) を入れて、追加/削除IP 列・行クリックに反映させる。変更項目も付ける。
      const props = [ranges ? { k: 'NETBLOCK', v: ranges } : null, g.sid ? { k: '接続点ID', v: g.sid } : null].filter(Boolean) as { k: string; v: string }[];
      events.push({
        eid: `domain:${g.id}:${g.date}:import:${i++}`, ts: `${g.date}T00-00-00`,
        entity: 'domain', id: g.id, name: g.name, change: g.change, field: 'IPアドレス範囲', old: '',
        new: [marker, ...extras].join(' / '), props,
      });
    }
    if (!events.length) throw new Error('取り込める行がありません（更新日・ドメイン名列を確認してください）');
    return events;
  }

  const events: QamEvent[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (j: number): string => (j >= 0 ? (r[j] ?? '').trim() : '');
    const date = normDate(get(dateI));
    let rawKey = keyIdx.map(get).find((v) => v) || '';
    if (entity === 'host') rawKey = stripProtocol(rawKey); // FQDN の http(s):// を除去
    if (!date || !rawKey) return; // 更新日・識別名が無い行はスキップ
    // Qualys ID へ解決。group/host は表示名(タイトル/FQDN)を ID に流用しない（未解決は空）。
    // domain/user は keyCols 自体が Qualys キーなので未解決でもそのまま採用。接続点IDは ID にしない。
    const id = resolveId(rawKey) || (spec.keyIsIdentity ? rawKey : '');
    let name = nameIdx.map(get).find((v) => v) || rawKey;
    if (entity === 'host') name = stripProtocol(name);
    const content = get(contentI);
    const extraVals: Record<string, string> = {};
    extraDefs.forEach(([label, j]) => { const v = get(j); if (v) extraVals[label] = v; });
    // IP/FQDN は専用列(追加/削除IP・FQDN)で表示するため、変更後テキストには入れない。
    const extras = Object.entries(extraVals).filter(([k]) => k !== 'IP' && k !== 'FQDN').map(([k, v]) => `${k}:${v}`);
    // host は IP/FQDN を props に入れて、追加/削除IP・FQDN 列・行クリックに反映させる。変更項目も付ける。
    let props: { k: string; v: string }[] | undefined;
    let field = '';
    if (entity === 'host') {
      props = [{ k: 'FQDN', v: name }, { k: 'IP', v: extraVals.IP ?? '' }, { k: '接続点ID', v: extraVals['接続点ID'] ?? '' }].filter((p) => p.v);
      field = 'IPアドレス・FQDN';
    }
    events.push({
      eid: `${entity}:${id}:${date}:import:${i}`,
      ts: `${date}T00-00-00`,
      entity, id, name,
      change: mapChange(get(typeI)) ?? inferChange(content || extras.join(' ')), // 変更種別列を優先、無ければ推定
      // CSV取込は項目単位の差分ではない。host/domain は IP/FQDN を props・変更項目に出す。group/user は空。
      field,
      old: '',
      // 全種別統一: 変更後/追加 列の先頭に「CSVインポートで登録」を入れ、取込履歴と分かるようにする。
      new: [marker, content, ...extras].filter(Boolean).join(' / '),
      ...(props && props.length ? { props } : {}),
    });
  });
  if (!events.length) throw new Error('取り込める行がありません（更新日・識別名列を確認してください）');
  return events;
}

// 既存呼び出し/テスト用の薄いラッパ。
export const parseGroupHistoryCsv = (text: string, resolveId?: (n: string) => string): QamEvent[] => parseHistoryCsv('group', text, resolveId);

// 取込モーダルに表示する各 entity の想定ヘッダ。
export const HIST_HEADER_HINT: Record<QamEntity, string> = {
  group: '更新日, 変更種別, 接続点ID, 事業場名(Division), タイトル, 接続名称(Function), 拠点名称(Location), メモ',
  domain: '更新日, 変更種別, 接続点ID, ドメイン名, IP_from, IP_to（同日はIP範囲を統合して1行に集約）',
  host: '更新日, 変更種別, 接続点ID, IPアドレス, FQDN（http(s):// は自動除去）',
  user: '更新日, 変更種別, 更新内容, 接続点ID, 氏名, 名前, 姓, 事業場名, TEL, e_mail, アカウント名, Language, 権限, ログイン方法(SAML), スキャン結果通知',
};
