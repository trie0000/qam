import { describe, it, expect } from 'vitest';
import {
  parseDynamicLists, parseCveList, diffCves, cveUpdateFields, parseSearchListIds,
  normalizeCve, searchListSummary,
} from '../src/searchlist';

// dynamic_list_output.dtd に沿った最小の応答。
// ★ID は OPTION_PROFILE / REPORT_TEMPLATE の中にも現れる。直下の子だけを見ないと別物を掴む。
const listXml = (id: string, title: string, cve: string): string => `<?xml version="1.0"?>
<DYNAMIC_SEARCH_LIST_OUTPUT><RESPONSE><DATETIME>2026-08-17T00:00:00Z</DATETIME><DYNAMIC_LISTS>
  <DYNAMIC_LIST>
    <ID>${id}</ID><TITLE><![CDATA[${title}]]></TITLE><GLOBAL>Yes</GLOBAL><OWNER>u</OWNER>
    <CRITERIA><CVE_ID><![CDATA[${cve}]]></CVE_ID></CRITERIA>
    <OPTION_PROFILES><OPTION_PROFILE><ID>999999</ID><TITLE>別物</TITLE></OPTION_PROFILE></OPTION_PROFILES>
  </DYNAMIC_LIST>
</DYNAMIC_LISTS></RESPONSE></DYNAMIC_SEARCH_LIST_OUTPUT>`;

describe('動的検索リストの解析', () => {
  it('ID / タイトル / CVE を取り出す', () => {
    const [l] = parseDynamicLists(listXml('381', 'RAS対象', 'CVE-2024-0001,CVE-2024-0002'));
    expect(l).toEqual({ id: '381', title: 'RAS対象', cves: ['CVE-2024-0001', 'CVE-2024-0002'] });
  });

  it('入れ子の ID を掴まない（オプションプロファイル等の ID と取り違えない）', () => {
    expect(parseDynamicLists(listXml('381', 'x', 'CVE-1')).map((l) => l.id)).toEqual(['381']);
  });

  it('CVE 未設定のリストは空配列', () => {
    const [l] = parseDynamicLists(`<?xml version="1.0"?><DYNAMIC_LISTS><DYNAMIC_LIST>
      <ID>7</ID><TITLE>空</TITLE><CRITERIA><PATCH_AVAILABLE>1</PATCH_AVAILABLE></CRITERIA>
    </DYNAMIC_LIST></DYNAMIC_LISTS>`);
    expect(l.cves).toEqual([]);
  });

  it('空応答・壊れた応答でも落とさない', () => {
    expect(parseDynamicLists('')).toEqual([]);
  });
});

describe('CVE リストの正規化', () => {
  it('カンマ・空白・改行のどれで区切られていても読む', () => {
    expect(parseCveList('CVE-1, CVE-2\nCVE-3  CVE-4')).toEqual(['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4']);
  });

  it('大文字小文字と前後空白のゆれを吸収し、重複は落とす', () => {
    expect(normalizeCve('  cve-2024-0001 ')).toBe('CVE-2024-0001');
    expect(parseCveList('cve-1,CVE-1, Cve-1')).toEqual(['CVE-1']);
  });
});

describe('差分の判定', () => {
  it('Excel 側にあって Qualys に無いものが追加、逆が削除', () => {
    const d = diffCves(['CVE-1', 'CVE-2'], ['CVE-2', 'CVE-3']);
    expect(d.added).toEqual(['CVE-1']);
    expect(d.removed).toEqual(['CVE-3']);
    expect(d.changed).toBe(true);
  });

  it('順序と表記だけの違いは差分にしない（無駄な再登録を避ける）', () => {
    // ★ここを厳密比較にすると、毎回「差分あり」で Qualys を叩き続けることになる。
    const d = diffCves(['cve-2', ' CVE-1 '], ['CVE-1', 'CVE-2']);
    expect(d.changed).toBe(false);
  });

  it('空同士は差分なし', () => {
    expect(diffCves([], []).changed).toBe(false);
  });
});

describe('更新リクエスト', () => {
  it('id を指定して丸ごと差し替える（作り直しではないので ID が変わらない）', () => {
    // ★delete+create にすると ID が変わり、設定に登録した検索リストIDが無効になる。
    expect(cveUpdateFields('381', ['CVE-1', 'CVE-2']))
      .toEqual({ action: 'update', id: '381', cve_ids: 'CVE-1,CVE-2' });
  });

  it('空にするときも update（cve_ids を空文字で送る）', () => {
    expect(cveUpdateFields('381', []).cve_ids).toBe('');
  });
});

describe('設定の検索リストID', () => {
  it('カンマ・改行区切りで複数登録でき、数字以外は落とす', () => {
    expect(parseSearchListIds('381, 6343529\n abc \n381')).toEqual(['381', '6343529']);
  });

  it('未設定なら空（呼び出し側が入力を促す）', () => {
    expect(parseSearchListIds('')).toEqual([]);
    expect(parseSearchListIds('  ')).toEqual([]);
  });
});

describe('結果のサマリ', () => {
  it('失敗・差分なし・更新をそれぞれ区別して出す', () => {
    expect(searchListSummary({ id: '1', title: 'A', added: [], removed: [], updated: false, error: '権限なし' })).toMatch(/失敗/);
    expect(searchListSummary({ id: '1', title: 'A', added: [], removed: [], updated: false })).toMatch(/差分なし/);
    expect(searchListSummary({ id: '1', title: 'A', added: ['CVE-1'], removed: [], updated: true })).toMatch(/追加 1 \/ 削除 0/);
  });
});
