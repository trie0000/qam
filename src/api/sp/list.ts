// SharePoint リストの薄いクライアント。リスト/列の自動作成（ensureList）と、
// 追記・更新（If-Match）・削除・全件取得（ページング）だけを持つ。
//
// 追記は POST。SPO が採番するので **複数人が同時に足してもロストアップデートが起きない**。
// 更新は MERGE + If-Match。他の人が先に直していれば 412 で弾かれる（呼び出し側が読み直す）。
import { V, errText, q, createSpHttp, type SpHttp, type SpHttpOptions } from './http';

export type FieldType = 'Text' | 'Note' | 'Number';
export interface FieldSpec {
  name: string;
  type: FieldType;
  /** 5000 件のしきい値対策。$filter で使う列に付ける。 */
  indexed?: boolean;
  /** SP 側で一意制約を張る（重複を原子的に弾く＝排他クレームにも使える）。要 indexed。 */
  enforceUnique?: boolean;
}

// SP.FieldType の数値。Note は複数行テキスト（Text の 255 文字制限を超えるもの）。
const FIELD_KIND: Record<FieldType, number> = { Text: 2, Note: 3, Number: 9 };

export interface SpItem extends Record<string, unknown> { Id: number; __etag: string }

export interface SpListClient {
  ensureList(title: string, fields: FieldSpec[]): Promise<void>;
  all(title: string, select?: string[]): Promise<SpItem[]>;
  add(title: string, row: Record<string, unknown>): Promise<void>;
  /** 更新できたら true、他の人が先に書いていたら false（412）。 */
  update(title: string, id: number, row: Record<string, unknown>, etag: string): Promise<boolean>;
  remove(title: string, id: number): Promise<void>;
}

export function createSpListClient(o: SpHttpOptions | { http: SpHttp }): SpListClient {
  const http: SpHttp = 'http' in o ? o.http : createSpHttp(o);
  const listApi = (title: string): string => `web/lists/getbytitle('${q(title)}')`;

  // POST の body には __metadata.type（ListItemEntityTypeFullName）が要る。リストごとに固定なので覚える。
  const typeCache = new Map<string, string>();
  async function itemType(title: string): Promise<string> {
    const hit = typeCache.get(title);
    if (hit) return hit;
    const r = await http.get(`${listApi(title)}?$select=ListItemEntityTypeFullName`);
    if (!r.ok) throw new Error(`リストの情報取得に失敗 (${title}): HTTP ${r.status}${await errText(r)}`);
    const t = String((await http.json(r)).ListItemEntityTypeFullName ?? '');
    if (!t) throw new Error(`リストの情報取得に失敗 (${title}): 型名が返りませんでした`);
    typeCache.set(title, t);
    return t;
  }

  const body = (type: string, row: Record<string, unknown>): string =>
    JSON.stringify({ __metadata: { type }, ...row });

  async function ensureFields(title: string, fields: FieldSpec[]): Promise<void> {
    const r = await http.get(`${listApi(title)}/fields?$select=InternalName,Indexed,EnforceUniqueValues&$top=500`);
    if (!r.ok) throw new Error(`列の一覧取得に失敗 (${title}): HTTP ${r.status}${await errText(r)}`);
    const rows = ((await http.json(r)).results ?? []) as { InternalName?: string; EnforceUniqueValues?: boolean }[];
    const have = new Map(rows.map((x) => [String(x.InternalName ?? ''), !!x.EnforceUniqueValues]));
    for (const f of fields) {
      if (!have.has(f.name)) {
        // 空白を含まない ASCII 名にしているので、内部名は表示名と一致する（_x0020_ 化されない）。
        const add = await http.post(`${listApi(title)}/fields`, {
          headers: { 'Content-Type': V },
          body: JSON.stringify({
            __metadata: { type: 'SP.Field' }, Title: f.name, FieldTypeKind: FIELD_KIND[f.type],
            ...(f.indexed || f.enforceUnique ? { Indexed: true } : {}),
          }),
        });
        if (!add.ok) throw new Error(`列の作成に失敗 (${title}.${f.name}): HTTP ${add.status}${await errText(add)}`);
      }
      // 一意制約は作成後に MERGE で立てる（既存環境にも後から効かせるため）。
      if (f.enforceUnique && !have.get(f.name)) {
        const upd = await http.post(`${listApi(title)}/fields/getbyinternalnameortitle('${q(f.name)}')`, {
          headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
          body: JSON.stringify({ __metadata: { type: 'SP.Field' }, Indexed: true, EnforceUniqueValues: true }),
        });
        // 既存データに重複があると失敗する。運用を止めない（重複は呼び出し側の整合で吸収する）。
        if (!upd.ok) console.warn(`[qam/sp] ${title}.${f.name} の一意制約を有効化できませんでした（続行）:`, upd.status);
      }
    }
  }

  return {
    async ensureList(title, fields) {
      const head = await http.get(`${listApi(title)}?$select=Id`);
      if (head.status === 404) {
        const r = await http.post('web/lists', {
          headers: { 'Content-Type': V },
          body: JSON.stringify({
            __metadata: { type: 'SP.List' }, Title: title, BaseTemplate: 100, // 100 = カスタムリスト
            AllowContentTypes: true, ContentTypesEnabled: false,
          }),
        });
        // 同時に他の人が作った場合も失敗しうるので、作成後に存在を確かめてから続ける。
        if (!r.ok && !(await http.get(`${listApi(title)}?$select=Id`)).ok) {
          throw new Error(`リストの作成に失敗 (${title}): HTTP ${r.status}${await errText(r)}`);
        }
      } else if (!head.ok) {
        throw new Error(`リストの確認に失敗 (${title}): HTTP ${head.status}${await errText(head)}`);
      }
      await ensureFields(title, fields);
    },

    async all(title, select) {
      const out: SpItem[] = [];
      // 5000 件のしきい値に触れないよう $top で刻み、__next を辿る。
      let rel: string | null = `${listApi(title)}/items?$top=2000${select?.length ? `&$select=Id,${select.join(',')}` : ''}`;
      let guard = 0;
      while (rel && guard++ < 500) {
        const r: Response = await http.get(rel); // 絶対 URL(__next) もそのまま通る
        if (r.status === 404) return out; // リスト未作成は 0 件扱い（初回起動）
        if (!r.ok) throw new Error(`一覧の取得に失敗 (${title}): HTTP ${r.status}${await errText(r)}`);
        const d = await http.json(r);
        for (const it of ((d.results ?? []) as Record<string, unknown>[])) {
          out.push({ ...it, Id: Number(it.Id), __etag: String((it.__metadata as { etag?: string } | undefined)?.etag ?? '') });
        }
        rel = (d.__next as string | undefined) ?? null;
      }
      return out;
    },

    async add(title, row) {
      const r = await http.post(`${listApi(title)}/items`, {
        headers: { 'Content-Type': V },
        body: body(await itemType(title), row),
      });
      if (!r.ok) throw new Error(`追加に失敗 (${title}): HTTP ${r.status}${await errText(r)}`);
    },

    async update(title, id, row, etag) {
      const r = await http.post(`${listApi(title)}/items(${id})`, {
        headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': etag || '*' },
        body: body(await itemType(title), row),
      });
      if (r.ok) return true;
      if (r.status === 412) return false; // 他の人が先に更新 → 呼び出し側で読み直す
      throw new Error(`更新に失敗 (${title}#${id}): HTTP ${r.status}${await errText(r)}`);
    },

    async remove(title, id) {
      const r = await http.post(`${listApi(title)}/items(${id})`, {
        headers: { 'X-HTTP-Method': 'DELETE', 'If-Match': '*' },
      });
      if (!r.ok && r.status !== 404) throw new Error(`削除に失敗 (${title}#${id}): HTTP ${r.status}${await errText(r)}`);
    },
  };
}
