// Qualys の動的検索リスト（dynamic search list）を、Excel の CVE 一覧に合わせる。
//
// エンドポイントは v3.0（/api/3.0/fo/qid/search_list/dynamic/）。
// ★v2.0 は EOS 2026-08 / EOL 2027-02。
// ★更新は action=update（id 指定）で行う。delete+create にすると **ID が変わり**、
//   設定に登録した検索リストIDが毎回無効になる（更新のたびに設定を手で直す運用になる）。
//
// 応答の構造（dynamic_list_output.dtd）:
//   DYNAMIC_LIST > (ID, TITLE, …, CRITERIA, …)
//   CRITERIA > CVE_ID?     … カンマ区切りの CVE 番号
// ★ID は OPTION_PROFILE / REPORT_TEMPLATE の中にも現れる。直下の子だけを見ないと
//   別物の ID を掴む。

export interface DynamicList { id: string; title: string; cves: string[] }

/** CVE 番号の表記ゆれを吸収する（前後空白・大文字小文字）。 */
export const normalizeCve = (s: string): string => (s ?? '').trim().toUpperCase();

/** カンマ・空白・改行区切りの CVE 文字列を配列にする（重複は除く・順序は入力順）。 */
export function parseCveList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? '').split(/[,\s]+/)) {
    const v = normalizeCve(raw);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

const directChild = (el: Element, tag: string): Element | null =>
  Array.from(el.children).find((c) => c.tagName === tag) ?? null;

const childText = (el: Element, tag: string): string => (directChild(el, tag)?.textContent ?? '').trim();

/** action=list の応答から検索リストを取り出す。 */
export function parseDynamicLists(xml: string): DynamicList[] {
  if (!xml.trim()) return [];
  let doc: Document;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return []; }
  const out: DynamicList[] = [];
  for (const el of Array.from(doc.getElementsByTagName('DYNAMIC_LIST'))) {
    const id = childText(el, 'ID');
    if (!id) continue;
    const criteria = directChild(el, 'CRITERIA');
    const cve = criteria ? childText(criteria, 'CVE_ID') : '';
    out.push({ id, title: childText(el, 'TITLE'), cves: parseCveList(cve) });
  }
  return out;
}

export interface CveDiff { added: string[]; removed: string[]; changed: boolean }

/** Excel 側（あるべき姿）と Qualys 側（現状）の差分。 */
export function diffCves(want: string[], current: string[]): CveDiff {
  const w = new Set(want.map(normalizeCve).filter(Boolean));
  const c = new Set(current.map(normalizeCve).filter(Boolean));
  const added = [...w].filter((x) => !c.has(x)).sort();
  const removed = [...c].filter((x) => !w.has(x)).sort();
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

/** update に渡すフォーム項目。CVE を丸ごと差し替える（差分適用の口は無い）。 */
export const cveUpdateFields = (id: string, cves: string[]): Record<string, string> =>
  ({ action: 'update', id, cve_ids: cves.join(',') });

/** 設定欄（カンマ・改行区切り）を検索リストIDの配列にする。数字だけを受け付ける。 */
export function parseSearchListIds(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? '').split(/[,\s]+/)) {
    const v = raw.trim();
    if (!/^\d+$/.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 1 リストぶんの更新結果（画面と操作履歴で共有する）。 */
export interface SearchListResult {
  id: string;
  title: string;
  added: string[];
  removed: string[];
  updated: boolean;   // 実際に Qualys を更新したか
  error?: string;
}

/** 結果の一行サマリ。 */
export const searchListSummary = (r: SearchListResult): string => {
  if (r.error) return `${r.title || r.id}: 失敗 — ${r.error}`;
  if (!r.updated) return `${r.title || r.id}: 差分なし（${r.added.length + r.removed.length === 0 ? '一致' : '未更新'}）`;
  return `${r.title || r.id}: 追加 ${r.added.length} / 削除 ${r.removed.length}`;
};
