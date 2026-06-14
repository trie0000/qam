import { describe, it, expect } from 'vitest';
import { parseGroupHistoryCsv } from '../src/ingest/history-csv';

describe('parseGroupHistoryCsv（AssetGroup 変更履歴CSV）', () => {
  const header = '更新日,更新内容,接続点ID,事業場名,タイトル,接続点名称(Function),拠点名称(Location),コメント(comments)';

  it('ヘッダ名で対応付け・更新日正規化・種別推定', () => {
    const csv = [
      header,
      '2026/6/1,新規登録,AB123,東京事業場,AB123 東京拠点,ルータ,本社,初期登録',
      '2026-06-15,IP変更,CD4567,大阪事業場,CD4567 大阪,SW,支社,',
      '2026.07.01,廃止,EF890,名古屋,EF890 名古屋,FW,営業所,撤去済',
    ].join('\n');
    const ev = parseGroupHistoryCsv(csv);
    expect(ev.length).toBe(3);
    expect(ev[0].ts).toBe('2026-06-01T00-00-00');
    expect(ev[0].id).toBe('AB123');
    expect(ev[0].name).toBe('AB123 東京拠点');
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
});
