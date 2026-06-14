import { describe, it, expect } from 'vitest';
import { parseGroupHistoryCsv, parseHistoryCsv } from '../src/ingest/history-csv';

describe('parseGroupHistoryCsv（AssetGroup 変更履歴CSV）', () => {
  const header = '更新日,更新内容,接続点ID,事業場名,タイトル,接続点名称(Function),拠点名称(Location),コメント(comments)';

  it('ヘッダ名で対応付け・更新日正規化・種別推定。ID=Qualys ID解決(未解決は空＝タイトルを流用しない)・接続点IDは併記', () => {
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
    expect(ev[1].id).toBe('');                // 未解決は空（タイトルを ID に流用しない）
    expect(ev[1].name).toBe('CD4567 大阪');   // タイトルは「名前」列に残る
    expect(ev[0].change).toBe('added'); // 新規登録
    expect(ev[0].new).toContain('新規登録');
    expect(ev[0].new).toContain('事業場:東京事業場');
    expect(ev[1].change).toBe('modified'); // IP変更
    expect(ev[2].change).toBe('deleted'); // 廃止
    expect(ev[2].ts).toBe('2026-07-01T00-00-00');
  });

  it('変更種別列があればその値を種別に使う（更新内容からの推定より優先）', () => {
    const csv = '更新日,変更種別,更新内容,接続点ID,事業場名,タイトル,接続点名称(Function),拠点名称(Location),コメント(comments)\n'
      + '2026-06-01,削除,新規登録した,AB123,東京,AB123 拠点,F,L,c'; // 内容は「登録」だが 変更種別=削除 を優先
    const ev = parseGroupHistoryCsv(csv);
    expect(ev[0].change).toBe('deleted');
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

  it('domain: ドメイン名=id / 接続点ID併記 / 単一IP範囲はレンジ表記', () => {
    const csv = '更新日,変更種別,接続点ID,ドメイン名,IP_from,IP_to\n'
      + '2026-06-01,新規,DM12,example.com,10.0.0.1,10.0.0.255';
    const ev = parseHistoryCsv('domain', csv);
    expect(ev[0].id).toBe('example.com'); // ドメイン名がID（=Qualysキー）。接続点IDではない
    expect(ev[0].name).toBe('example.com');
    expect(ev[0].change).toBe('added');
    expect(ev[0].new).toContain('接続点ID:DM12'); // 接続点IDは併記
    expect(ev[0].new).toContain('IP:10.0.0.1-10.0.0.255');
  });

  it('domain: 同日・同ドメイン・同種別を1レコードに集約。連続範囲は統合・非連続はカンマ区切り', () => {
    const csv = '更新日,変更種別,接続点ID,ドメイン名,IP_from,IP_to\n'
      + '2026-06-01,変更,DM1,example.com,10.0.0.1,10.0.0.10\n'   // ← この2行は隣接(…10と…11)で
      + '2026-06-01,変更,DM1,example.com,10.0.0.11,10.0.0.20\n'  //    統合され 1-20 に
      + '2026-06-01,変更,DM1,example.com,10.0.5.5,\n'            // ← 離れた単一IPは別途併記
      + '2026-06-02,変更,DM1,example.com,10.0.9.9,';            // ← 別日は別レコード
    const ev = parseHistoryCsv('domain', csv);
    expect(ev.length).toBe(2); // 06-01 集約1件 + 06-02 1件
    const d1 = ev.find((e) => e.ts.startsWith('2026-06-01'))!;
    expect(d1.new).toContain('IP:10.0.0.1-10.0.0.20, 10.0.5.5');
    const d2 = ev.find((e) => e.ts.startsWith('2026-06-02'))!;
    expect(d2.new).toContain('IP:10.0.9.9');
  });

  it('host: FQDN の http(s):// を除去 / 未解決時 id は空 / 接続点ID・IPを併記', () => {
    const csv = '更新日,変更種別,接続点ID,IPアドレス,FQDN\n'
      + '2026-06-02,追加,AB123,10.1.1.1,https://host1.example/';
    const ev = parseHistoryCsv('host', csv);
    expect(ev[0].id).toBe('');                // 未解決は空（FQDN を Host ID に流用しない）
    expect(ev[0].name).toBe('host1.example'); // http(s):// と末尾スラッシュを除去
    expect(ev[0].change).toBe('added');
    expect(ev[0].new).toContain('接続点ID:AB123');
    expect(ev[0].new).toContain('IP:10.1.1.1');
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
