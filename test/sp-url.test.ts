import { describe, it, expect } from 'vitest';
import { parseSpFileUrl, spFileValueUrl, isAbsoluteUrl } from '../src/sp-url';

describe('SharePoint のファイル URL', () => {
  it('絶対 URL と相対パスを見分ける', () => {
    expect(isAbsoluteUrl('https://example.sharepoint.com/sites/x/a.xlsx')).toBe(true);
    expect(isAbsoluteUrl('ras/CVE対応策一覧.xlsx')).toBe(false);
  });

  it('直リンクからサイトとサーバ相対パスを取り出す', () => {
    const r = parseSpFileUrl('https://example.sharepoint.com/sites/Sec/Shared%20Documents/ras/a.xlsx');
    expect(r).toEqual({
      site: 'https://example.sharepoint.com/sites/Sec',
      serverRelativePath: '/sites/Sec/Shared Documents/ras/a.xlsx',
    });
  });

  it('共有リンクの装飾（/:x:/r）とクエリを落とす', () => {
    // 「リンクのコピー」で貼られる形。そのまま fetch すると HTML が返る。
    const r = parseSpFileUrl('https://example.sharepoint.com/:x:/r/sites/Sec/Shared%20Documents/a.xlsx?d=w123&csf=1&web=1');
    expect(r.site).toBe('https://example.sharepoint.com/sites/Sec');
    expect(r.serverRelativePath).toBe('/sites/Sec/Shared Documents/a.xlsx');
  });

  it('teams サイトも同じように扱う', () => {
    expect(parseSpFileUrl('https://example.sharepoint.com/teams/Net/Docs/a.xlsx').site)
      .toBe('https://example.sharepoint.com/teams/Net');
  });

  it('ルートサイト直下のファイルも扱える', () => {
    const r = parseSpFileUrl('https://example.sharepoint.com/Shared%20Documents/a.xlsx');
    expect(r.site).toBe('https://example.sharepoint.com');
    expect(r.serverRelativePath).toBe('/Shared Documents/a.xlsx');
  });

  it('sourcedoc 形式は、何を貼ればよいかを言って失敗する', () => {
    // ★ID 参照の共有リンクにはパスが無いので解決できない。黙って失敗させない。
    expect(() => parseSpFileUrl('https://example.sharepoint.com/sites/Sec/_layouts/15/Doc.aspx?sourcedoc=%7BGUID%7D'))
      .toThrow(/パスのコピー/);
  });

  it('ファイルに見えない URL は弾く', () => {
    expect(() => parseSpFileUrl('https://example.sharepoint.com/sites/Sec/Shared%20Documents')).toThrow(/拡張子/);
  });

  it('URL でないものは弾く', () => {
    expect(() => parseSpFileUrl('ras/a.xlsx')).toThrow(/URL として読めません/);
  });

  it('本体取得の URL を組み立てる（シングルクォートはエスケープ）', () => {
    expect(spFileValueUrl({ site: 'https://x/sites/S', serverRelativePath: "/sites/S/Docs/it's.xlsx" }))
      .toBe("https://x/sites/S/_api/web/GetFileByServerRelativeUrl('/sites/S/Docs/it''s.xlsx')/$value");
  });
});
