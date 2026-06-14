import { describe, it, expect } from 'vitest';
import { parseGroupHistoryCsv, parseHistoryCsv } from '../src/ingest/history-csv';

describe('parseGroupHistoryCsv（AssetGroup 変更履歴CSV）', () => {
  const header = '更新日,更新内容,接続点ID,事業場名,タイトル,接続点名称(Function),拠点名称(Location),コメント(comments)';

  it('ヘッダ名で対応付け・更新日正規化・種別推定。ID=Qualys ID解決(無ければタイトル)・接続点IDは併記', () => {
    const csv = [
      header,
      '2026/6/1,新規登録,AB123,東京事業場,AB123 東京拠点,ルータ,本社,初期登録',
      '2026-06-15,IP変更,CD4567,大阪事業場,CD4567 大阪,SW,支社,',
      '2026.07.01,廃止,EF890,名古屋,EF890 名古屋,FW,営業所,撤去済',
    ].join('\n');
    // タイトル→Qualys ID の解決器（AB123 東京拠点 のみ snapshot にあるとする）
    const resolve = (n: string) => (n === 'AB123 東京拠点' ? '634851' : '');
    const ev = parseGroupHistoryCsv(csv, resolve);
    expect(ev.length).toBe(3);
    expect(ev[0].ts).toBe('2026-06-01T00-00-00');
    expect(ev[0].id).toBe('634851');         // 解決された Qualys AssetGroup ID
    expect(ev[0].name).toBe('AB123 東京拠点');
    expect((ev[0].new ?? '').startsWith('CSVインポートで登録')).toBe(true); // 取込マーカー
    expect(ev[0].new).toContain('接続点ID:AB123'); // 接続点IDはID列でなく併記
    expect(ev[1].id).toBe('CD4567 大阪');     // 未解決はタイトルにフォールバック（接続点IDではない）
    expect(ev[0].change).toBe('added'); // 新規登録
    expect(ev[0].new).toContain('新規登録');
    expect(ev[0].new).toContain('事業場:東京事業場');
    expect(ev[1].change).toBe('modified'); // IP変更
    expect(ev[2].change).toBe('deleted'); // 廃止
    expect(ev[2].ts).toBe('2026-07-01T00-00-00');
  });

  it('クォート内のカンマを正しく扱う', () => {
    const csv = header + '\n' + '2026-06-01,"IP追加,DNS変更",AB123,場,AB123 拠点,F,L,c';
    const ev = parseGroupHistoryCsv(csv);
    expect(ev[0].new).toContain('IP追加,DNS変更');
  });

  it('更新日や識別子が無い行はスキップ', () => {
    const csv = header + '\n' + ',内容のみ,,事業場,,F,L,c';
    expect(() => parseGroupHistoryCsv(csv)).toThrow(/取り込める行/);
  });

  it('domain: 接続点ID=id / ドメイン名=name / IP範囲・外接番号を併記', () => {
    const csv = '更新日,更新内容,接続点ID,事業場名,ドメイン名,IPアドレス範囲_from,IPアドレス範囲_to,外接番号\n'
      + '2026-06-01,新規,DM12,東京,example.com,10.0.0.1,10.0.0.255,EXT9';
    const ev = parseHistoryCsv('domain', csv);
    expect(ev[0].id).toBe('example.com'); // ドメイン名がID（=Qualysキー）。接続点IDではない
    expect(ev[0].name).toBe('example.com');
    expect(ev[0].change).toBe('added');
    expect(ev[0].new).toContain('接続点ID:DM12'); // 接続点IDは併記
    expect(ev[0].new).toContain('IP範囲from:10.0.0.1');
    expect(ev[0].new).toContain('IP範囲to:10.0.0.255');
    expect(ev[0].new).toContain('外接番号:EXT9');
  });

  it('host: 更新内容が無く メモ を本文に / FQDN=id(未解決時) / 外接番号は併記', () => {
    const csv = '更新日,接続点名,IPアドレス,FQDN,メモ,外接番号\n'
      + '2026-06-02,東京拠点,10.1.1.1,host1.example,初期構築,EXT1';
    const ev = parseHistoryCsv('host', csv);
    expect(ev[0].id).toBe('host1.example'); // FQDN（未解決時のフォールバック）。外接番号ではない
    expect(ev[0].name).toBe('host1.example');
    expect(ev[0].field).toBe('メモ');
    expect(ev[0].new).toContain('初期構築');
    expect(ev[0].new).toContain('接続点名:東京拠点');
    expect(ev[0].new).toContain('外接番号:EXT1');
  });

  it('user: アカウント名=id / 氏名=name / 権限などを併記', () => {
    const csv = '更新日,更新内容,接続点ID,氏名,名前,姓,事業場名,TEL,e_mail,アカウント名,Language,権限,ログイン方法(SAML),スキャン結果通知\n'
      + '2026-06-03,権限変更,U99,山田 太郎,太郎,山田,東京,03-0000,a@e.x,acme_yamada,ja,Manager,SAML,有効';
    const ev = parseHistoryCsv('user', csv);
    expect(ev[0].id).toBe('acme_yamada');
    expect(ev[0].name).toBe('山田 太郎');
    expect(ev[0].new).toContain('権限:Manager');
    expect(ev[0].new).toContain('ログイン方法:SAML');
  });
});
