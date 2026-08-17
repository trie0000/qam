import { describe, it, expect } from 'vitest';
import { readXlsxSheet, columnUntilBlankRow } from '../src/xlsx-read';

// Excel が実際に書き出す形（deflate 圧縮＋共有文字列表）の xlsx をその場で組み立てる。
// ★バイナリの fixture を置くより、中身が読める形でテストに書いたほうが
//   「何を検証しているか」が分かる。圧縮も実際に通す（store だけだと展開経路が未検証になる）。
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(data as unknown as BufferSource); void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** deflate 圧縮した ZIP を組む（xlsx の実体）。 */
async function makeZip(files: { name: string; text: string }[]): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const put = (n: number, len: number): number[] => Array.from({ length: len }, (_, i) => (n >>> (8 * i)) & 0xff);
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.text);
    const comp = await deflateRaw(raw);
    const crc = crc32(raw);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0,
      ...put(crc, 4), ...put(comp.length, 4), ...put(raw.length, 4),
      ...put(name.length, 2), 0, 0, ...name, ...comp,
    ]);
    chunks.push(local);
    central.push(new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0,
      ...put(crc, 4), ...put(comp.length, 4), ...put(raw.length, 4),
      ...put(name.length, 2), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...put(offset, 4), ...name,
    ]));
    offset += local.length;
  }
  const cd = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0,
    ...put(files.length, 2), ...put(files.length, 2), ...put(cd, 4), ...put(offset, 4), 0, 0,
  ]);
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out.buffer;
}

// 共有文字列表。セルは t="s" で添字を持つ（Excel が実際に使う形）。
const SHARED = ['CVE対応策一覧', 'CVE番号', '対応策', 'CVE-2024-0001', 'パッチ適用', 'CVE-2024-0002',
  '設定変更', '対象列だけ空', 'CVE-2024-0003', '回避策', 'CVE-9999-9999', '無関係'];
// ★Excel は氏名等に「ふりがな」を持つ。<rPh> の中にも <t> があるので、除かないと
//   「山田 太郎ヤマダ タロウ」のように漢字の後ろにカタカナが付く（実際に踏んだ）。
const SHARED_XML = SHARED.map((s) => `<si><t>${s}</t></si>`).join('')
  + '<si><t>山田 太郎</t><rPh sb="0" eb="2"><t>ヤマダ</t></rPh><rPh sb="3" eb="5"><t>タロウ</t></rPh><phoneticPr fontId="1"/></si>';
const c = (ref: string, i: number): string => `<c r="${ref}" t="s"><v>${i}</v></c>`;
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1">${c('A1', 0)}</row>
  <row r="2">${c('A2', 1)}${c('B2', 2)}</row>
  <row r="3">${c('A3', 3)}${c('B3', 4)}</row>
  <row r="4">${c('A4', 5)}${c('B4', 6)}</row>
  <row r="5">${c('B5', 7)}</row>
  <row r="6">${c('A6', 8)}${c('B6', 9)}</row>
  <row r="8">${c('A8', 10)}</row>
  <row r="9">${c('A9', SHARED.length)}</row>
</sheetData></worksheet>`;

const build = (): Promise<ArrayBuffer> => makeZip([
  { name: 'xl/workbook.xml', text: '<?xml version="1.0"?><workbook><sheets>'
      + '<sheet name="別シート" sheetId="1" r:id="rId1"/>'
      + '<sheet name="CVE対応策一覧" sheetId="2" r:id="rId2"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0"?><Relationships>'
      + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>' },
  { name: 'xl/sharedStrings.xml', text: '<?xml version="1.0"?><sst>'
      + SHARED_XML + '</sst>' },
  { name: 'xl/worksheets/sheet1.xml', text: `<?xml version="1.0"?><worksheet><sheetData><row r="1">${c('A1', 11)}</row></sheetData></worksheet>` },
  { name: 'xl/worksheets/sheet2.xml', text: SHEET },
]);

describe('xlsx の読み取り', () => {
  it('シート名で目的のシートを開ける', async () => {
    const s = await readXlsxSheet(await build(), 'CVE対応策一覧');
    expect(s.name).toBe('CVE対応策一覧');
    expect(s.rows.length).toBeGreaterThan(0);
  });

  it('共有文字列を解決して文字列として読む（添字のまま返さない）', async () => {
    // ★t="s" の <v> は共有文字列表の添字。取り違えると数字が並ぶだけになる。
    const s = await readXlsxSheet(await build(), 'CVE対応策一覧');
    expect(s.rows.find((r) => r.row === 3)!.cells.A).toBe('CVE-2024-0001');
  });

  it('A3以下を、行全体が空になるまで読む', async () => {
    const s = await readXlsxSheet(await build(), 'CVE対応策一覧');
    // 7行目（行そのものが無い＝空行）で打ち切るので、8行目の CVE-9999-9999 は読まない。
    expect(columnUntilBlankRow(s.rows, 'A', 3)).toEqual(['CVE-2024-0001', 'CVE-2024-0002', 'CVE-2024-0003']);
  });

  it('対象列だけ空の行では止まらない（途中の抜けで以降を取りこぼさない）', async () => {
    // 5行目は A が空・B に値あり。ここで止まると CVE-2024-0003 が落ちる。
    const s = await readXlsxSheet(await build(), 'CVE対応策一覧');
    expect(columnUntilBlankRow(s.rows, 'A', 3)).toContain('CVE-2024-0003');
  });

  it('無いシート名は、実在するシート名を添えて失敗させる', async () => {
    await expect(readXlsxSheet(await build(), 'CVE一覧')).rejects.toThrow(/CVE対応策一覧/);
  });

  it('xlsx でないものは読めないと分かる形で失敗させる', async () => {
    await expect(readXlsxSheet(new TextEncoder().encode('not a zip').buffer as ArrayBuffer, 'x'))
      .rejects.toThrow(/xlsx として読めません/);
  });
});

describe('ふりがな（<rPh>）の扱い', () => {
  it('氏名の後ろにふりがなを連結しない', async () => {
    const s = await readXlsxSheet(await build(), 'CVE対応策一覧');
    // 9行目には「山田 太郎」＋ふりがな付きのセルを置いてある。
    expect(s.rows.find((r) => r.row === 9)!.cells.A).toBe('山田 太郎');
  });
});
