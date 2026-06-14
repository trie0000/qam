import { describe, it, expect } from 'vitest';
import { settenId, fmtJst } from '../src/ui/columns';

describe('settenId（接続点ID 切り出し）', () => {
  it('タイトル先頭〜最初の半角スペースを切り出す（形式ルールなし）', () => {
    expect(settenId('AB123 東京拠点ルータ')).toBe('AB123');
    expect(settenId('CD1234D 大阪')).toBe('CD1234D');
    expect(settenId('A123 単一英字でもそのまま')).toBe('A123');
    expect(settenId('ABCD 数字なしでもそのまま')).toBe('ABCD');
    expect(settenId('AB123-1 余分な文字も先頭トークンとして採用')).toBe('AB123-1');
  });
  it('半角スペースが無ければ全体、空は空', () => {
    expect(settenId('AB123')).toBe('AB123');
    expect(settenId('接続点なし')).toBe('接続点なし');
    expect(settenId('')).toBe('');
  });
});

describe('fmtJst（ISO UTC → JST 表示）', () => {
  it('UTC を +9h して JST 表記にする（端末TZ非依存）', () => {
    expect(fmtJst('2024-06-13T08:30:00Z')).toBe('2024-06-13 17:30:00 JST');
    expect(fmtJst('2024-12-31T15:00:00Z')).toBe('2025-01-01 00:00:00 JST'); // 日跨ぎ
    expect(fmtJst('2024-06-13T23:59:59Z')).toBe('2024-06-14 08:59:59 JST');
  });
  it('空/パース不能はそのまま', () => {
    expect(fmtJst('')).toBe('');
    expect(fmtJst('N/A')).toBe('N/A');
  });
});
