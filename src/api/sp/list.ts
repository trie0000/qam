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
// 既存列との型突き合わせ用（SP が返す TypeAsString）。
const TYPE_NAME: Record<FieldType, string> = { Text: 'Text', Note: 'Note', Number: 'Number' };

export interface SpItem extends Record<string, unknown> { Id: number; __etag: string }

export interface EnsureListOptions {
  /** 組み込みの Title 列に一意制約を張る（Title を一意キーに使うリスト）。 */
  uniqueTitle?: boolean;
  /** フォームを差し替える JSON（コンテンツタイプの ClientFormCustomFormatter）。 */
  formFormatter?: string;
  /** 使わなくなった列。残すと空欄のまま並んで紛らわしいので消す（組み込み列は消さない）。 */
  dropFields?: string[];
  /** 組み込み Title 列の表示名（内部名は Title のまま）。 */
  titleLabel?: string;
  /** 既定ビューに出す列と、その順番。 */
  viewFields?: string[];
  /** 列ごとの表示書式（内部名 → JSON）。 */
  fieldFormatters?: Record<string, string>;
}

export interface SpListClient {
  ensureList(title: string, fields: FieldSpec[], opts?: EnsureListOptions): Promise<void>;
  all(title: string, select?: string[]): Promise<SpItem[]>;
  add(title: string, row: Record<string, unknown>): Promise<void>;
  /** 更新できたら true、他の人が先に書いていたら false（412）。 */
  update(title: string, id: number, row: Record<string, unknown>, etag: string): Promise<boolean>;
  remove(title: string, id: number): Promise<void>;
  /** リストの既定ビューの絶対URL。無ければ空文字。 */
  viewUrl(title: string): Promise<string>;
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
    const r = await http.get(`${listApi(title)}/fields?$select=InternalName,TypeAsString,CanBeDeleted,Indexed,EnforceUniqueValues&$top=500`);
    if (!r.ok) throw new Error(`列の一覧取得に失敗 (${title}): HTTP ${r.status}${await errText(r)}`);
    type Row = { InternalName?: string; TypeAsString?: string; CanBeDeleted?: boolean; EnforceUniqueValues?: boolean };
    const rows = ((await http.json(r)).results ?? []) as Row[];
    const have = new Map(rows.map((x) => [String(x.InternalName ?? ''), x]));
    for (const f of fields) {
      const cur = have.get(f.name);
      // ★列名が SP の組み込み列と衝突していると、作成は「既にある」で素通りするのに
      //   書き込みだけが必ず失敗する（例: Author は組み込みの User 型）。
      //   黙って壊れるより、ここで名前を指して止める。
      if (cur && (cur.CanBeDeleted === false || (cur.TypeAsString && cur.TypeAsString !== TYPE_NAME[f.type]))) {
        throw new Error(`列名が SharePoint の既存列と衝突しています (${title}.${f.name} は ${cur.TypeAsString}${cur.CanBeDeleted === false ? '・組み込み列' : ''})。別の列名にしてください`);
      }
      if (!cur) {
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
      if (f.enforceUnique && !cur?.EnforceUniqueValues) {
        const upd = await http.post(`${listApi(title)}/fields/getbyinternalnameortitle('${q(f.name)}')`, {
          headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
          body: JSON.stringify({ __metadata: { type: 'SP.Field' }, Indexed: true, EnforceUniqueValues: true }),
        });
        // 既存データに重複があると失敗する。運用を止めない（重複は呼び出し側の整合で吸収する）。
        if (!upd.ok) console.warn(`[qam/sp] ${title}.${f.name} の一意制約を有効化できませんでした（続行）:`, upd.status);
      }
    }
  }

  // 使わなくなった列を消す。名前を明示したものだけが対象で、組み込み列には触らない。
  // ★残しておくと、値の入らない列が一覧やフォームに並び続けて「どちらが正か」が分からなくなる。
  async function dropFields(title: string, names: string[]): Promise<void> {
    for (const name of names) {
      const r = await http.get(`${listApi(title)}/fields/getbyinternalnameortitle('${q(name)}')?$select=CanBeDeleted`);
      if (!r.ok) continue; // 既に無い
      if ((await http.json(r)).CanBeDeleted === false) continue; // 組み込み列は消さない
      const del = await http.post(`${listApi(title)}/fields/getbyinternalnameortitle('${q(name)}')`, {
        headers: { 'X-HTTP-Method': 'DELETE', 'If-Match': '*' },
      });
      if (!del.ok) console.warn(`[qam/sp] ${title}.${name} を削除できませんでした（続行）:`, del.status);
    }
  }

  // 列の表示書式（一覧のセルの見せ方）。CustomFormatter に JSON を入れる。
  async function setFieldFormatters(title: string, formatters: Record<string, string>): Promise<void> {
    for (const [name, json] of Object.entries(formatters)) {
      const r = await http.get(`${listApi(title)}/fields/getbyinternalnameortitle('${q(name)}')?$select=CustomFormatter`);
      if (!r.ok) continue;
      if (String((await http.json(r)).CustomFormatter ?? '') === json) continue;
      const upd = await http.post(`${listApi(title)}/fields/getbyinternalnameortitle('${q(name)}')`, {
        headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
        body: JSON.stringify({ __metadata: { type: 'SP.Field' }, CustomFormatter: json }),
      });
      if (!upd.ok) console.warn(`[qam/sp] ${title}.${name} の列書式を設定できませんでした（続行）:`, upd.status);
    }
  }

  // Title 列の表示名だけを変える（内部名 Title はそのまま。書式や参照は内部名で動く）。
  async function setTitleLabel(title: string, label: string): Promise<void> {
    const r = await http.get(`${listApi(title)}/fields/getbyinternalnameortitle('Title')?$select=Title`);
    if (!r.ok) return;
    if (String((await http.json(r)).Title ?? '') === label) return;
    const upd = await http.post(`${listApi(title)}/fields/getbyinternalnameortitle('Title')`, {
      headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
      body: JSON.stringify({ __metadata: { type: 'SP.Field' }, Title: label }),
    });
    if (!upd.ok) console.warn(`[qam/sp] ${title}.Title の表示名を変更できませんでした（続行）:`, upd.status);
  }

  // 既定ビューの列と並び順を揃える。★一度全部外してから順に足す。
  // 足すだけだと、既にある列が前に残って指定した順にならない。
  async function setViewFields(title: string, fields: string[]): Promise<void> {
    const viewApi = `${listApi(title)}/DefaultView`;
    const cur = await http.get(`${viewApi}/ViewFields`);
    if (!cur.ok) return;
    const have = (((await http.json(cur)).Items as { results?: unknown[] } | undefined)?.results ?? []).map(String);
    if (have.length === fields.length && have.every((v, i) => v === fields[i])) return; // 既に同じ
    const rm = await http.post(`${viewApi}/ViewFields/removeallviewfields`);
    if (!rm.ok) { console.warn(`[qam/sp] ${title} の既定ビューを更新できませんでした（続行）:`, rm.status); return; }
    for (const f of fields) {
      const add = await http.post(`${viewApi}/ViewFields/addviewfield('${q(f)}')`);
      if (!add.ok) console.warn(`[qam/sp] ${title} のビューに ${f} を追加できませんでした（続行）:`, add.status);
    }
  }

  // Title は SP 組み込み列なので ensureFields のガード（組み込み列は弾く）を通せない。
  // 作成はせず、一意制約だけを立てる。
  async function ensureUniqueTitle(title: string): Promise<void> {
      const r = await http.get(`${listApi(title)}/fields/getbyinternalnameortitle('Title')?$select=EnforceUniqueValues`);
      if (!r.ok) return;
      if ((await http.json(r)).EnforceUniqueValues === true) return;
      const upd = await http.post(`${listApi(title)}/fields/getbyinternalnameortitle('Title')`, {
        headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
        body: JSON.stringify({ __metadata: { type: 'SP.Field' }, Indexed: true, EnforceUniqueValues: true }),
      });
      // 既存データに重複があると失敗する。運用は止めない（重複は同期側の整合で吸収する）。
      if (!upd.ok) console.warn(`[qam/sp] ${title}.Title の一意制約を有効化できませんでした（続行）:`, upd.status);
    }

  // フォームを読み取り専用カードにする。書き込み先はコンテンツタイプの
  // ClientFormCustomFormatter（キーは headerJSONFormatter）。
  async function applyFormFormatter(title: string, formatter: string): Promise<void> {
      const r = await http.get(`${listApi(title)}/ContentTypes?$select=StringId,ClientFormCustomFormatter`);
      if (!r.ok) return;
      const rows = ((await http.json(r)).results ?? []) as { StringId?: unknown; ClientFormCustomFormatter?: unknown }[];
      // 既定コンテンツタイプ＝先頭。フォルダー(0x0120…)は対象外。
      const ct = rows.find((c) => !String(c.StringId ?? '').startsWith('0x0120'));
      if (!ct) return;
      if (String(ct.ClientFormCustomFormatter ?? '') === formatter) return; // 変化なし
      const upd = await http.post(`${listApi(title)}/ContentTypes('${q(String(ct.StringId))}')`, {
        headers: { 'Content-Type': V, 'X-HTTP-Method': 'MERGE', 'If-Match': '*' },
        body: JSON.stringify({ __metadata: { type: 'SP.ContentType' }, ClientFormCustomFormatter: formatter }),
      });
      if (!upd.ok) console.warn(`[qam/sp] ${title} のフォーム書式を設定できませんでした（続行）:`, upd.status);
    }

  async function ensureListImpl(title: string, fields: FieldSpec[], opts?: EnsureListOptions): Promise<void> {
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
      if (opts?.dropFields?.length) await dropFields(title, opts.dropFields);
      if (opts?.uniqueTitle) await ensureUniqueTitle(title);
      if (opts?.titleLabel) await setTitleLabel(title, opts.titleLabel);
      if (opts?.viewFields?.length) await setViewFields(title, opts.viewFields);
      if (opts?.fieldFormatters) await setFieldFormatters(title, opts.fieldFormatters);
      if (opts?.formFormatter) await applyFormFormatter(title, opts.formFormatter);
    }

  return {
    ensureList: ensureListImpl,

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

    async viewUrl(title) {
      // ★URL を '<site>/Lists/<Title>' と組み立てない。リスト名を後から変えたり、
      //   作成時に別の内部名が付いたりすると 404 になる。SP に持っている値を聞く。
      const r = await http.get(`${listApi(title)}?$select=DefaultViewUrl,RootFolder/ServerRelativeUrl&$expand=RootFolder`);
      if (!r.ok) return '';
      const d = await http.json(r);
      const rel = String(d.DefaultViewUrl ?? '') || String((d.RootFolder as { ServerRelativeUrl?: unknown } | undefined)?.ServerRelativeUrl ?? '');
      if (!rel) return '';
      try { return new URL(rel, http.site).toString(); } catch { return ''; }
    },

    async remove(title, id) {
      const r = await http.post(`${listApi(title)}/items(${id})`, {
        headers: { 'X-HTTP-Method': 'DELETE', 'If-Match': '*' },
      });
      if (!r.ok && r.status !== 404) throw new Error(`削除に失敗 (${title}#${id}): HTTP ${r.status}${await errText(r)}`);
    },
  };
}
