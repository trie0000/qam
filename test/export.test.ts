import { describe, it, expect } from 'vitest';
import { toCsv, buildXlsx, type Sheet } from '../src/export';

const sheet: Sheet = {
  name: '資産一覧',
  headers: ['ID', '名前', 'コメント'],
  rows: [
    ['1', 'web "01"', 'カンマ,改行\nあり'],
    ['2', 'db-01', ''],
  ],
};

describe('export', () => {
  it('CSV は RFC4180 でエスケープし CRLF 区切り', () => {
    const csv = toCsv(sheet);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('ID,名前,コメント');
    // " を含むセルは "" にして全体を囲む / カンマ・改行を含むセルも囲む
    expect(lines[1]).toBe('1,"web ""01""","カンマ,改行\nあり"');
    expect(lines[2]).toBe('2,db-01,');
  });

  it('xlsx は ZIP(PK) で、ヘッダ・セル値・色付き書式・オートフィルタを含む', () => {
    const buf = buildXlsx(sheet);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
    const txt = new TextDecoder().decode(buf); // store(無圧縮)なので本文がそのまま読める
    expect(txt).toContain('資産一覧');         // シート名
    expect(txt).toContain('web &quot;01&quot;'); // セル値(XMLエスケープ)
    expect(txt).toContain('autoFilter');        // オートフィルタ
    expect(txt).toContain('FF4E7A51');           // ヘッダ塗り色
    expect(txt).toContain('state="frozen"');    // 見出し行固定
  });
});
