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
// v1 のスケジュールマップは 1 タスクに複数ドメインを指定できる（TARGETS がカンマ区切り）。
export interface MapScheduleRow { id: string; title: string; active: boolean; nextLaunch: string; domains: string[] }

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

// 次回実行予定。UTC 系の要素名が版で揺れるので候補を並べる。
const nextLaunchOf = (el: Element): string =>
  pick(el, ['nextlaunch', 'next_launch'], ['NEXTLAUNCH_UTC', 'NEXT_LAUNCH_UTC', 'NEXTLAUNCH', 'NEXT_LAUNCH']);

// 指定タグの要素を集める（複数候補タグに対応）。
function elements(doc: Document, tags: string[]): Element[] {
  for (const t of tags) {
    const list = Array.from(doc.getElementsByTagName(t));
    if (list.length) return list;
  }
  return [];
}

// 実施済みスキャン一覧（/api/2.0/fo/scan/?action=list）。
export function parseScanList(xml: string): ScanRun[] {
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
  const doc = parseXmlDocument(xml);
  return elements(doc, ['SCAN']).map((s) => ({
    id: pick(s, ['id'], ['ID']),
    title: pick(s, ['title'], ['TITLE']),
    active: isActive(s),
    nextLaunch: nextLaunchOf(s),
    assetGroups: assetGroupTitles(s),
  }));
}

// スケジュール済みマップ一覧（v1 /msp/scheduled_scans.php?type=map）。
//   <SCHEDULEDSCANS><MAP active="yes" ref="11155"><TITLE/><TARGETS>dom1, dom2</TARGETS>
//     <SCHEDULE>…</SCHEDULE><NEXTLAUNCH_UTC>…</NEXTLAUNCH_UTC></MAP></SCHEDULEDSCANS>
// v1 は type=map でもタスク要素が <SCAN> で返る場合があるため両方を見る。
// TARGETS はカンマ区切りで、ドメインと AssetGroup 名が混在しうる（ドメイン照合なので非ドメインは素通り）。
export function parseMapSchedules(xml: string): MapScheduleRow[] {
  const doc = parseXmlDocument(xml);
  return elements(doc, ['MAP', 'SCAN']).map((m) => ({
    id: pick(m, ['id', 'ref'], ['ID', 'REF']),
    title: pick(m, ['title'], ['TITLE']),
    active: isActive(m),
    nextLaunch: nextLaunchOf(m),
    domains: uniq(csv(pick(m, ['domain'], ['TARGETS', 'DOMAIN', 'TARGET']))),
  }));
}
