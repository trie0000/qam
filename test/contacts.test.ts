import { describe, it, expect } from 'vitest';
import { parseContacts, contactsByScope, HEADER_ROW } from '../src/contacts';
import type { SheetRow } from '../src/xlsx-read';

// 体制表の形（テーブルオブジェクトではない素の表）。3行目が見出し、B列が正／副。
// 列の位置は環境で変わり得るので、見出しの部分一致で拾えることを確かめる。
const row = (n: number, cells: Record<string, string>): SheetRow => ({ row: n, cells });
const sheet = (): SheetRow[] => [
  row(1, { A: '事業場ITセキュリティ体制含む一覧' }),
  row(2, { A: '（2026年度）' }),
  row(HEADER_ROW, { A: 'No', B: '正／副', C: '管轄範囲', D: '所属部署', E: '氏名（漢字）', F: '連絡先e-mailアドレス' }),
  row(4, { A: '1', B: '正', C: 'A事業会社', D: 'IT統括部', E: '山田 太郎', F: 'taro@example.com' }),
  row(5, { A: '2', B: '副', C: 'A事業会社', D: 'IT統括部', E: '鈴木 次郎', F: 'jiro@example.com' }),
  row(6, { A: '3', B: '正', C: 'B事業会社', D: '情報システム', E: '佐藤 花子', F: 'hanako@example.com' }),
];

describe('体制表からの連絡先抽出', () => {
  it('B列が「正」の行だけを取る', () => {
    const r = parseContacts(sheet());
    expect(r.contacts.map((c) => c.name)).toEqual(['山田 太郎', '佐藤 花子']);
    expect(r.skipped).toBe(1); // 「副」の行
  });

  it('見出しの部分一致で列を拾う（列の位置や表記ゆれに耐える）', () => {
    const r = parseContacts(sheet());
    expect(r.contacts[0]).toEqual({
      scope: 'A事業会社', dept: 'IT統括部', name: '山田 太郎', email: 'taro@example.com',
    });
    expect(r.usedHeaders['e-mail']).toBe('連絡先e-mailアドレス');
  });

  it('E-Mail のような表記ゆれも拾う', () => {
    const rows = sheet();
    rows[2].cells.F = 'E-Mail';
    expect(parseContacts(rows).contacts[0].email).toBe('taro@example.com');
  });

  it('行全体が空になったら以降は読まない', () => {
    const rows = [...sheet(), row(7, {}), row(8, { B: '正', C: 'C事業会社', E: '読まれない', F: 'x@example.com' })];
    expect(parseContacts(rows).contacts.map((c) => c.scope)).toEqual(['A事業会社', 'B事業会社']);
  });

  it('メールアドレスが無い行は落とす（宛先の無い下書きを作らない）', () => {
    const rows = [...sheet(), row(7, { B: '正', C: 'C事業会社', D: 'x', E: '担当者', F: '' })];
    expect(parseContacts(rows).contacts.map((c) => c.scope)).toEqual(['A事業会社', 'B事業会社']);
  });

  it('見出しが見つからなければ、読めた見出しを添えて失敗させる', () => {
    // ★列がずれたまま空の連絡先を作ると、宛先の無いメール下書きが黙って出来上がる。
    const rows = sheet();
    delete rows[2].cells.F;
    expect(() => parseContacts(rows)).toThrow(/e-mail/);
    expect(() => parseContacts(rows)).toThrow(/管轄範囲/); // 読めた見出しも出す
  });

  it('見出し行が無ければ失敗させる', () => {
    expect(() => parseContacts([row(1, { A: 'x' })])).toThrow(/3 行目/);
  });

  it('管轄範囲ごとにまとめられる', () => {
    const m = contactsByScope(parseContacts(sheet()).contacts);
    expect([...m.keys()]).toEqual(['A事業会社', 'B事業会社']);
    expect(m.get('A事業会社')![0].email).toBe('taro@example.com');
  });
});
