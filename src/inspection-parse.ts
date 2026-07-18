// Qualys の scan/map 実施一覧・スケジュール一覧 XML → 検査状況判定用のレコード。
// 構造の正典は docs/QUALYS_XML.md。要素名・属性名はサブスクリプションや API 版で揺れる
// （domain が属性 domain の場合と子要素 DOMAIN/TARGET の場合がある等）ため、
// 候補を順に探す「緩い」抽出にして、取れなければ空文字で返す（落とさない）。
import { parseXmlDocument } from './ingest/parse';

// 実施済みスキャン 1 件。assetGroups は AssetGroup 指定で起動した場合のみ入る。
export interface ScanRun { ref: string; title: string; datetime: string; state: string; assetGroups: string[] }
// 実施済みマップ 1 件。domain はマップ対象ドメイン。
export interface MapRun { ref: string; title: string; datetime: string; state: string; domain: string }
// スケジュール 1 件。nextLaunch は次回実行予定（ISO）。
export interface ScanScheduleRow { id: string; title: string; active: boolean; nextLaunch: string; assetGroups: string[] }
// v1 のスケジュールマップ。TARGETS は「ドメイン:[ネットブロック]」形式を複数取りうる。
// AssetGroup 指定でも組めるので assetGroups も保持する（ドメイン照合の補完に使う）。
export interface MapScheduleRow {
  id: string; title: string; active: boolean; nextLaunch: string;
  domains: string[]; assetGroups: string[];
}

const txt = (n: Element | null): string => (n ? (n.textContent ?? '').trim() : '');

// 子孫要素のうち、候補タグ名で最初に値が入っているものを返す。
function firstText(el: Element, tags: string[]): string {
  for (const t of tags) {
    const v = txt(el.getElementsByTagName(t)[0] ?? null);
    if (v) return v;
  }
  return '';
}

// 属性のうち、候補名で最初に値が入っているものを返す。
function firstAttr(el: Element, names: string[]): string {
  for (const n of names) {
    const v = (el.getAttribute(n) ?? '').trim();
    if (v) return v;
  }
  return '';
}

// 属性優先 → 子要素の順で拾う（Qualys は同じ意味の値を版によって属性/要素どちらでも返す）。
const pick = (el: Element, attrs: string[], tags: string[]): string => firstAttr(el, attrs) || firstText(el, tags);

// カンマ区切り文字列 → トークン配列。
const csv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

const uniq = (a: string[]): string[] => Array.from(new Set(a.filter(Boolean)));

// SCAN/スケジュール要素から対象 AssetGroup タイトルを集める。
// ASSET_GROUP_TITLE_LIST>ASSET_GROUP_TITLE が正、CSV の ASSET_GROUPS 系も拾う。
function assetGroupTitles(el: Element): string[] {
  const titles = Array.from(el.getElementsByTagName('ASSET_GROUP_TITLE')).map((n) => txt(n));
  const csvTitles = csv(firstText(el, ['ASSET_GROUPS', 'ASSET_GROUP_TITLES']));
  return uniq([...titles, ...csvTitles]);
}

// ACTIVE=1 / active="yes"(v1) / true を有効とみなす。値が無い場合は有効扱い（一覧に出ている＝有効が既定）。
function isActive(el: Element): boolean {
  const v = pick(el, ['active'], ['ACTIVE']).toLowerCase();
  if (!v) return true;
  return v === '1' || v === 'true' || v === 'yes';
}

// v1 は <NEXTLAUNCH_UTC>2026-07-19T15:00:00</NEXTLAUNCH_UTC> のように Z を付けずに返す。
// そのまま Date に渡すとローカル時刻扱いになるので、要素名どおり UTC として解釈させる。
const asUtc = (v: string): string => (v && !/([Zz]|[+-]\d{2}:?\d{2})$/.test(v) ? `${v}Z` : v);

// 次回実行予定。UTC 系の要素名が版で揺れるので候補を並べる。
const nextLaunchOf = (el: Element): string =>
  asUtc(pick(el, ['nextlaunch', 'next_launch'], ['NEXTLAUNCH_UTC', 'NEXT_LAUNCH_UTC', 'NEXTLAUNCH', 'NEXT_LAUNCH']));

// Qualys の map ターゲットは「ドメイン:[ネットブロック, ネットブロック]」形式を取る
// （例: example.jp:[10.0.0.1, 10.0.0.2]）。角括弧の中のカンマで割らないよう深さ 0 のカンマだけで
// 分割し、':' より前をドメインとして採る。'none' はネットブロックのみのマップを表す予約語。
export function parseMapTargets(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const flush = (): void => {
    const tok = cur.trim();
    cur = '';
    if (!tok) return;
    const dom = tok.split(':')[0].trim().toLowerCase();
    if (dom && dom !== 'none') out.push(dom);
  };
  for (const ch of raw) {
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { flush(); continue; }
    cur += ch;
  }
  flush();
  return uniq(out);
}

// 指定タグの要素を集める（複数候補タグに対応）。
function elements(doc: Document, tags: string[]): Element[] {
  for (const t of tags) {
    const list = Array.from(doc.getElementsByTagName(t));
    if (list.length) return list;
  }
  return [];
}

// 未取得/取得失敗のエンドポイントは空文字で渡ってくる。パースを試みると例外になり
// ビュー全体が描画できなくなるので、空は「0 件」として扱う。
const isBlank = (xml: string): boolean => !xml || !xml.trim();

// 実施済みスキャン一覧（/api/2.0/fo/scan/?action=list）。
export function parseScanList(xml: string): ScanRun[] {
  if (isBlank(xml)) return [];
  const doc = parseXmlDocument(xml);
  // SCHEDULE_SCAN_LIST_OUTPUT と取り違えないよう、スケジュール応答なら空を返す。
  if (doc.documentElement.nodeName.startsWith('SCHEDULE_')) return [];
  return elements(doc, ['SCAN']).map((s) => ({
    ref: pick(s, ['ref'], ['REF']),
    title: pick(s, ['title'], ['TITLE']),
    datetime: pick(s, ['date', 'datetime'], ['LAUNCH_DATETIME', 'DATETIME', 'DATE']),
    state: pick(s, ['status', 'state'], ['STATE', 'STATUS']),
    assetGroups: assetGroupTitles(s),
  }));
}

// 実施済みマップ一覧（v1 /msp/map_report_list.php）。ref/date/domain/status は MAP_REPORT の属性。
//   <MAP_REPORT_LIST><MAP_REPORT ref=".." date=".." domain=".." status="FINISHED"><TITLE/>…
// v2 に相当エンドポイントは無い（/api/2.0/fo/map/ は 404）。
export function parseMapList(xml: string): MapRun[] {
  if (isBlank(xml)) return [];
  const doc = parseXmlDocument(xml);
  const root = doc.documentElement.nodeName;
  if (root.startsWith('SCHEDULE') || root === 'SCHEDULEDSCANS') return []; // スケジュール応答を誤読しない
  return elements(doc, ['MAP_REPORT', 'MAP']).map((m) => ({
    ref: pick(m, ['ref'], ['REF']),
    title: pick(m, ['title'], ['TITLE']),
    datetime: pick(m, ['date', 'datetime'], ['LAUNCH_DATETIME', 'DATETIME', 'DATE']),
    state: pick(m, ['status', 'state'], ['STATE', 'STATUS']),
    domain: pick(m, ['domain'], ['DOMAIN', 'TARGET']),
  }));
}

// スケジュール済みスキャン一覧（/api/2.0/fo/schedule/scan/?action=list）。
export function parseScanSchedules(xml: string): ScanScheduleRow[] {
  if (isBlank(xml)) return [];
  const doc = parseXmlDocument(xml);
  return elements(doc, ['SCAN']).map((s) => ({
    id: pick(s, ['id'], ['ID']),
    title: pick(s, ['title'], ['TITLE']),
    active: isActive(s),
    nextLaunch: nextLaunchOf(s),
    assetGroups: assetGroupTitles(s),
  }));
}

// スケジュール済みマップ一覧（v1 /msp/scheduled_scans.php?type=map）。実応答の形:
//   <SCHEDULEDSCANS>
//     <SCAN active="yes" ref="1000001">          ← type=map でも要素名は SCAN
//       <TITLE/><TARGETS>ドメイン:[IP, IP]</TARGETS>
//       <SCHEDULE><WEEKLY …/>…</SCHEDULE>
//       <NEXTLAUNCH_UTC>2026-07-19T15:00:00</NEXTLAUNCH_UTC>   ← Z 無し・SCHEDULE の外
//       <TYPE>MAP</TYPE>
//       <ASSET_GROUPS><ASSET_GROUP><ASSET_GROUP_TITLE/></ASSET_GROUP></ASSET_GROUPS>
//     </SCAN>
//   </SCHEDULEDSCANS>
export function parseMapSchedules(xml: string): MapScheduleRow[] {
  if (isBlank(xml)) return [];
  const doc = parseXmlDocument(xml);
  return elements(doc, ['MAP', 'SCAN'])
    // scan と map が混在する応答に備え、TYPE があれば MAP のみ採る（無い版は全件）。
    .filter((m) => { const t = firstText(m, ['TYPE']).toUpperCase(); return !t || t === 'MAP'; })
    .map((m) => ({
      id: pick(m, ['id', 'ref'], ['ID', 'REF']),
      title: pick(m, ['title'], ['TITLE']),
      active: isActive(m),
      nextLaunch: nextLaunchOf(m),
      // 対象の入れ物は版で名前が異なる。値は「ドメイン:[ネットブロック]」形式を想定して解く。
      domains: parseMapTargets(pick(m, ['domain', 'target', 'targets'], ['TARGETS', 'SCAN_TARGET', 'DOMAINS', 'DOMAIN', 'TARGET'])),
      assetGroups: assetGroupTitles(m),
    }));
}
