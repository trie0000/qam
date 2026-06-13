// 一覧/履歴のエクスポート。依存を増やさず、CSV と「色付きヘッダ・罫線・見出し固定・
// オートフィルタ付き」の本物の .xlsx（OOXML を手組みした ZIP）を生成する。
// xlsx は ZIP(=複数XMLの束)。圧縮は無し(store)で十分小さく、CRC32 だけ自前計算する。

export interface Sheet { name: string; headers: string[]; rows: string[][] }

// ---- ダウンロード ----
function save(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- CSV（Excel が UTF-8 を正しく開くよう BOM 付き、CRLF・RFC4180 エスケープ） ----
const csvCell = (s: string): string => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
export function toCsv(sheet: Sheet): string {
  return [sheet.headers, ...sheet.rows].map((r) => r.map((c) => csvCell(c ?? '')).join(',')).join('\r\n');
}
export function exportCsv(sheet: Sheet, filename: string): void {
  save(filename, new Blob(['﻿', toCsv(sheet)], { type: 'text/csv;charset=utf-8' }));
}

// ---- xlsx ----
const xmlEsc = (s: string): string => (s ?? '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // XML 1.0 で不正な制御文字は除去
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colLetter(i: number): string { // 0 始まり → A, B, ... Z, AA...
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>`
+ `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>`
+ `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
+ `<fill><patternFill patternType="solid"><fgColor rgb="FF4E7A51"/><bgColor indexed="64"/></patternFill></fill></fills>`
+ `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>`
+ `<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>`
+ `<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>`
+ `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
+ `<cellXfs count="3">`
+ `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
+ `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
+ `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`
+ `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function cellXml(ref: string, text: string, style: number): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const nCols = sheet.headers.length;
  const lastCol = colLetter(Math.max(0, nCols - 1));
  const lastRow = sheet.rows.length + 1;
  // 列幅: ヘッダと各行のテキスト長から推定（全角は約2倍幅）。10〜60 にクランプ。
  const width = (i: number): number => {
    let max = sheet.headers[i]?.length ?? 0;
    for (const r of sheet.rows) {
      const v = r[i] ?? '';
      let w = 0; for (const ch of v) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
      if (w > max) max = w;
    }
    return Math.min(60, Math.max(10, max + 2));
  };
  const cols = Array.from({ length: nCols }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${width(i)}" customWidth="1"/>`).join('');
  const head = `<row r="1">` + sheet.headers.map((h, i) => cellXml(`${colLetter(i)}1`, h, 1)).join('') + `</row>`;
  const body = sheet.rows.map((r, ri) =>
    `<row r="${ri + 2}">` + r.map((v, ci) => cellXml(`${colLetter(ci)}${ri + 2}`, v ?? '', 2)).join('') + `</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
    + `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + `<cols>${cols}</cols>`
    + `<sheetData>${head}${body}</sheetData>`
    + `<autoFilter ref="A1:${lastCol}${lastRow}"/>`
    + `</worksheet>`;
}

// シート名は31字以内・[]:*?/\ 不可・ブック内で一意。安全化して重複は連番付与。
function sheetNames(names: string[]): string[] {
  const used = new Set<string>(); const out: string[] = [];
  names.forEach((raw, i) => {
    let n = (raw || `Sheet${i + 1}`).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(n.toLowerCase())) { const suf = `(${i + 1})`; n = n.slice(0, 31 - suf.length) + suf; }
    used.add(n.toLowerCase()); out.push(n);
  });
  return out;
}

function workbookXml(names: string[]): string {
  const sheets = names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets}</sheets></workbook>`;
}

function contentTypes(n: number): string {
  const overrides = Array.from({ length: n }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + overrides
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

function wbRels(n: number): string {
  const sheets = Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets
    + `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

// ---- 最小 ZIP（store・無圧縮）。CRC32 を自前計算。 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZEntry { name: string; data: Uint8Array; crc: number; offset: number }

function zip(files: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const entries: ZEntry[] = [];
  let offset = 0;
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const push = (b: Uint8Array) => { parts.push(b); offset += b.length; };

  for (const f of files) {
    const data = enc.encode(f.content);
    const nameB = enc.encode(f.name);
    const crc = crc32(data);
    entries.push({ name: f.name, data, crc, offset });
    // ローカルファイルヘッダ
    push(u32(0x04034b50)); push(u16(20)); push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0));
    push(u32(crc)); push(u32(data.length)); push(u32(data.length));
    push(u16(nameB.length)); push(u16(0)); push(nameB); push(data);
  }
  // セントラルディレクトリ
  const cdStart = offset;
  for (const e of entries) {
    const nameB = enc.encode(e.name);
    push(u32(0x02014b50)); push(u16(20)); push(u16(20)); push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0));
    push(u32(e.crc)); push(u32(e.data.length)); push(u32(e.data.length));
    push(u16(nameB.length)); push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0)); push(u32(0)); push(u32(e.offset));
    push(nameB);
  }
  const cdSize = offset - cdStart;
  push(u32(0x06054b50)); push(u16(0)); push(u16(0)); push(u16(entries.length)); push(u16(entries.length));
  push(u32(cdSize)); push(u32(cdStart)); push(u16(0));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// 複数シートのブックを生成（1シートのときは [sheet] を渡せばよい）。
export function buildXlsxBook(sheets: Sheet[]): Uint8Array {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }];
  const names = sheetNames(list.map((s) => s.name));
  return zip([
    { name: '[Content_Types].xml', content: contentTypes(list.length) },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'xl/workbook.xml', content: workbookXml(names) },
    { name: 'xl/_rels/workbook.xml.rels', content: wbRels(list.length) },
    { name: 'xl/styles.xml', content: STYLES },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
  ]);
}
export const buildXlsx = (sheet: Sheet): Uint8Array => buildXlsxBook([sheet]);

function saveXlsx(buf: Uint8Array, filename: string): void {
  save(filename, new Blob([buf as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
export const exportXlsx = (sheet: Sheet, filename: string): void => saveXlsx(buildXlsx(sheet), filename);
export const exportXlsxBook = (sheets: Sheet[], filename: string): void => saveXlsx(buildXlsxBook(sheets), filename);
