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

// 1 つの検索リストに入れる CVE の上限。運用で決めた値。
// 超えた分は次の検索リストへこぼす（Qualys 側の入力上限を避けるための分割）。
export const CVE_PER_LIST = 150;

/** 上限ごとに切り分ける。 */
export function chunkCves(cves: string[], size = CVE_PER_LIST): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < cves.length; i += size) out.push(cves.slice(i, i + size));
  return out;
}

export interface SearchListAssignment {
  id: string;
  title: string;
  /** 更新後にこのリストへ入れる CVE。 */
  cves: string[];
  /** このリストから外れる CVE。 */
  removed: string[];
  /** このリストへ新しく入る CVE。 */
  added: string[];
  /** 実際に Qualys を更新する必要があるか。 */
  changed: boolean;
}

export interface SearchListPlan {
  assignments: SearchListAssignment[];
  /** どのリストにも入れられなかった CVE。★黙って捨てない。 */
  overflow: string[];
  /** あと何個リストがあれば収まるか。 */
  needMoreLists: number;
}

/**
 * 「今どのリストに何が入っているか」を土台に、動いた分だけを割り当てる。
 *
 * ★位置で機械的に詰め直さない。Excel の先頭に 1 件足しただけで全リストの中身が
 *   ずれ、毎回すべてのリストを更新することになる（Qualys 側の更新履歴も汚れる）。
 * 手順:
 *   1. 各リストに今ある CVE のうち、Excel にも在るものはそのまま残す
 *   2. Excel から消えたものは、入っていたリストから外す
 *   3. Excel にしか無いものを、空きのあるリストへ設定順に入れる
 *   4. 中身が変わったリストだけ changed=true
 *
 * current は Qualys から読んだ現状。どのCVEがどのリストに居るかの管理はこれ自体が
 * 台帳なので、別に対応表を持たない（別に持つと Qualys の実態とずれる）。
 */
export function planSearchListUpdates(
  want: string[], ids: string[], current: DynamicList[], size = CVE_PER_LIST, rebuild = false,
): SearchListPlan {
  const wantSet = new Set(want.map(normalizeCve).filter(Boolean));
  const byId = new Map(current.map((l) => [l.id, l]));

  // 作り直し: 既存の割り当てを無視し、Excel の順に size 件ずつ詰め直す。
  // 割り当てが崩れて全リストが更新され得るので、明示的に選んだときだけ行う。
  if (rebuild) {
    const chunks = chunkCves(want.map(normalizeCve).filter(Boolean), size);
    const assignments = ids.map((id, i) => {
      const cur = byId.get(id);
      const curCves = (cur?.cves ?? []).map(normalizeCve);
      const cves = chunks[i] ?? [];
      const d = diffCves(cves, curCves);
      return { id, title: cur?.title ?? '', cves, added: d.added, removed: d.removed, changed: d.changed };
    });
    const overflow = chunks.slice(ids.length).flat();
    return { assignments, overflow, needMoreLists: overflow.length ? chunks.length - ids.length : 0 };
  }

  // 1〜2: 既存の割り当てを維持しつつ、Excel から消えたものを外す。
  const kept = ids.map((id) => {
    const cur = byId.get(id);
    const curCves = (cur?.cves ?? []).map(normalizeCve);
    return {
      id, title: cur?.title ?? '', curCves,
      keep: curCves.filter((c) => wantSet.has(c)),
      removed: curCves.filter((c) => !wantSet.has(c)),
    };
  });

  // 3: どのリストにも無い CVE を、空きのあるリストへ設定順に入れる。
  const placed = new Set(kept.flatMap((k) => k.keep));
  const fresh = want.map(normalizeCve).filter((c) => c && !placed.has(c));
  const added: string[][] = ids.map(() => []);
  let i = 0;
  for (const c of fresh) {
    while (i < kept.length && kept[i].keep.length + added[i].length >= size) i++;
    if (i >= kept.length) break; // 空きが無い＝あふれ
    added[i].push(c);
  }
  const overflow = fresh.slice(added.reduce((n, a) => n + a.length, 0));

  const assignments: SearchListAssignment[] = kept.map((k, n) => {
    const cves = [...k.keep, ...added[n]];
    return {
      id: k.id, title: k.title, cves, added: added[n], removed: k.removed,
      changed: added[n].length > 0 || k.removed.length > 0,
    };
  });
  const free = assignments.reduce((n, a) => n + Math.max(0, size - a.cves.length), 0);
  return { assignments, overflow, needMoreLists: overflow.length ? Math.ceil((overflow.length - free) / size) || 1 : 0 };
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
