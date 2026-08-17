// .xlsx の読み取り（必要な範囲だけ）。既存の CVE 対応策一覧を読むために使う。
//
// xlsx は ZIP に XML を詰めたもの。外部ライブラリを足さない方針なので、
// 必要な部分だけ自前で解く:
//   1. ZIP の中央ディレクトリから目的のエントリを探す
//   2. 無圧縮(store) はそのまま、Deflate は DecompressionStream('deflate-raw') で展開
//   3. workbook.xml + rels でシート名 → シートXML を引き、共有文字列を解決してセルを読む
//
// ★セル値は共有文字列表(sharedStrings.xml)に入っていることが多い。t="s" のとき
//   <v> は文字列そのものではなく**表の添字**。ここを取り違えると数字が並ぶだけになる。

const u16 = (b: DataView, o: number): number => b.getUint16(o, true);
const u32 = (b: DataView, o: number): number => b.getUint32(o, true);

interface ZipEntry { name: string; method: number; offset: number; size: number }

/** 中央ディレクトリを読んでエントリ表を作る。 */
function readZipIndex(buf: ArrayBuffer): Map<string, ZipEntry> {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // EOCD(0x06054b50) を末尾から探す。コメントは最大 65535 バイト。
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx として読めません（ZIP の終端が見つかりません）');
  const count = u16(dv, eocd + 10);
  let p = u32(dv, eocd + 16);
  const out = new Map<string, ZipEntry>();
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10);
    const size = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const offset = u32(dv, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { name, method, offset, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // xlsx の圧縮は raw deflate（zlib ヘッダ無し）。
  // ★Blob().stream() は使わない（テスト環境の DOM 実装に無いことがある）。
  //   writable に直接書けば、ブラウザでも Node でも同じ経路で通る。
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  void w.write(data as unknown as BufferSource);
  void w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

async function readEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf);
  if (u32(dv, e.offset) !== 0x04034b50) throw new Error(`ZIP の内部構造が壊れています (${e.name})`);
  const nameLen = u16(dv, e.offset + 26);
  const extraLen = u16(dv, e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buf, start, e.size);
  const data = e.method === 0 ? raw : await inflate(raw);
  return new TextDecoder('utf-8').decode(data);
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // &amp; は最後（先に戻すと二重解釈になる）

/** sharedStrings.xml → 添字順の文字列。<si> 内の <t> を連結する（書式付きは複数 <r><t>）。 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]));
    out.push(parts.join(''));
  }
  return out;
}

/** セル参照 'AB12' → { col: 'AB', row: 12 }。 */
function parseRef(ref: string): { col: string; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return m ? { col: m[1], row: Number(m[2]) } : { col: '', row: 0 };
}

export interface SheetRow { row: number; cells: Record<string, string> }

/** シートXML を「行番号 → 列→値」に開く。 */
export function parseSheet(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rn = Number(/\br="(\d+)"/.exec(rm[1])?.[1] ?? 0);
    const cells: Record<string, string> = {};
    for (const cm of rm[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
      let v = '';
      if (type === 'inlineStr') {
        v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join('');
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        // ★t="s" の <v> は共有文字列表の添字。そのまま使うと数字が並ぶ。
        v = type === 's' ? (shared[Number(raw)] ?? '') : unescapeXml(raw);
      }
      const { col } = parseRef(ref);
      if (col) cells[col] = v.trim();
    }
    if (rn) rows.push({ row: rn, cells });
  }
  return rows;
}

/**
 * 指定シートの1列を、開始行から「行全体が空になるまで」読む。
 * ★空セルで止めない。対象列だけ空で他に値がある行は飛ばして続ける
 *   （途中の抜けで打ち切ると、以降のCVEを丸ごと取りこぼす）。
 */
export function columnUntilBlankRow(rows: SheetRow[], col: string, fromRow: number): string[] {
  const byRow = new Map(rows.map((r) => [r.row, r]));
  const last = rows.reduce((n, r) => Math.max(n, r.row), 0);
  const out: string[] = [];
  for (let n = fromRow; n <= last; n++) {
    const r = byRow.get(n);
    const empty = !r || Object.values(r.cells).every((v) => v === '');
    if (empty) break; // 行全体が空 ＝ ここで終わり
    const v = r.cells[col] ?? '';
    if (v) out.push(v);
  }
  return out;
}

export interface XlsxSheet { name: string; rows: SheetRow[] }

/** xlsx を開いて、指定名のシートを読む。シートが無ければ、在るシート名を添えて失敗させる。 */
export async function readXlsxSheet(buf: ArrayBuffer, sheetName: string): Promise<XlsxSheet> {
  const idx = readZipIndex(buf);
  const need = (name: string): ZipEntry => {
    const e = idx.get(name);
    if (!e) throw new Error(`xlsx の中に ${name} がありません`);
    return e;
  };
  const wb = await readEntry(buf, need('xl/workbook.xml'));
  const rels = await readEntry(buf, need('xl/_rels/workbook.xml.rels'));
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: unescapeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? ''),
    rid: /\br:id="([^"]*)"/.exec(m[1])?.[1] ?? '',
  }));
  const hit = sheets.find((s) => s.name === sheetName);
  if (!hit) throw new Error(`シート「${sheetName}」がありません（このファイルのシート: ${sheets.map((s) => s.name).join(' / ') || 'なし'}）`);
  const target = /\bTarget="([^"]*)"/.exec(
    new RegExp(`<Relationship\\b[^>]*Id="${hit.rid}"[^>]*>`).exec(rels)?.[0] ?? '',
  )?.[1] ?? '';
  if (!target) throw new Error(`シート「${sheetName}」の実体を特定できません`);
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const shared = idx.has('xl/sharedStrings.xml') ? parseSharedStrings(await readEntry(buf, need('xl/sharedStrings.xml'))) : [];
  return { name: hit.name, rows: parseSheet(await readEntry(buf, need(path)), shared) };
}
