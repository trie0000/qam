// 事業会社ごとの連絡先（イントラの体制表から取る）。
//
// 元は社内イントラに置かれている Excel。表はテーブルオブジェクトではなく、ただの罫線表:
//   ・シート名に「体制含む」を含むシートを見る
//   ・3 行目がヘッダ
//   ・B 列（正／副）が「正」の行だけを対象にする
//   ・列は見出しの**部分一致**で拾う（列の位置は変わり得るが、見出しの語は変わらない）
//
// このファイルは UI にも SharePoint にも依存しない（vitest で検証する）。
import type { SheetRow } from './xlsx-read';

export interface Contact {
  /** 管轄範囲。ここに出てくる名前が「宛先Excel内の事業会社名」。 */
  scope: string;
  dept: string;   // 所属
  name: string;   // 氏名
  email: string;  // 連絡先メールアドレス
}

/** 見出しの部分一致で列を探す。見つからなければ -1。 */
const findCol = (header: Record<string, string>, part: RegExp): string => {
  const hit = Object.entries(header).find(([, v]) => part.test(v));
  return hit ? hit[0] : '';
};

export interface ContactParseResult {
  contacts: Contact[];
  /** 実際に使った見出し（意図した列を読めたか画面で確かめられるように）。 */
  usedHeaders: Record<string, string>;
  /** 「正」でないなどで除いた行数。 */
  skipped: number;
}

export const HEADER_ROW = 3;
/** 正／副の列。仕様で B 列と決まっている。 */
export const ROLE_COL = 'B';
export const ROLE_PRIMARY = '正';

/**
 * 体制表から「正」の連絡先を取り出す。
 * ★見出しが1つでも見つからなければ、読めた見出しを添えて失敗させる。列がずれたまま
 *   空の連絡先を作ると、宛先の無いメール下書きが黙って出来上がる。
 */
export function parseContacts(rows: SheetRow[]): ContactParseResult {
  const head = rows.find((r) => r.row === HEADER_ROW);
  if (!head) throw new Error(`${HEADER_ROW} 行目に見出しがありません`);
  const cols = {
    scope: findCol(head.cells, /管轄範囲/),
    dept: findCol(head.cells, /所属/),
    name: findCol(head.cells, /氏名/),
    email: findCol(head.cells, /e-?mail/i),
  };
  const missing = Object.entries({ 管轄範囲: cols.scope, 所属: cols.dept, 氏名: cols.name, 'e-mail': cols.email })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`見出しが見つかりません（${missing.join(' / ')}）。${HEADER_ROW} 行目の見出し: ${Object.values(head.cells).filter(Boolean).join(' / ') || 'なし'}`);
  }

  const contacts: Contact[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.row <= HEADER_ROW) continue;
    // 行全体が空なら表の終わり。以降は読まない。
    if (Object.values(r.cells).every((v) => v === '')) break;
    if ((r.cells[ROLE_COL] ?? '').trim() !== ROLE_PRIMARY) { skipped++; continue; }
    const c: Contact = {
      scope: (r.cells[cols.scope] ?? '').trim(),
      dept: (r.cells[cols.dept] ?? '').trim(),
      name: (r.cells[cols.name] ?? '').trim(),
      email: (r.cells[cols.email] ?? '').trim(),
    };
    // 宛先が無い行は連絡先として使えない。数えて落とす（黙って空の宛先を作らない）。
    if (!c.email) { skipped++; continue; }
    contacts.push(c);
  }
  return {
    contacts, skipped,
    usedHeaders: {
      管轄範囲: head.cells[cols.scope] ?? '', 所属: head.cells[cols.dept] ?? '',
      氏名: head.cells[cols.name] ?? '', 'e-mail': head.cells[cols.email] ?? '',
    },
  };
}

/** 管轄範囲（宛先Excel内の事業会社名）→ 連絡先。同じ管轄が複数行あれば全部持つ。 */
export function contactsByScope(contacts: Contact[]): Map<string, Contact[]> {
  const m = new Map<string, Contact[]>();
  for (const c of contacts) {
    if (!c.scope) continue;
    const cur = m.get(c.scope) ?? [];
    cur.push(c);
    m.set(c.scope, cur);
  }
  return m;
}
