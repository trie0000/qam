import { describe, it, expect } from 'vitest';
import { settenId } from '../src/ui/columns';

describe('settenId（接続点ID 切り出し）', () => {
  it('タイトル先頭〜最初の半角スペースを切り出す', () => {
    expect(settenId('AB123 東京拠点ルータ')).toBe('AB123');
    expect(settenId('CD1234D 大阪')).toBe('CD1234D');
  });
  it('形式: 英字2 + 数字3〜4桁 + 末尾D任意 のみ有効', () => {
    expect(settenId('AB123')).toBe('AB123');      // 末尾が数字
    expect(settenId('AB1234')).toBe('AB1234');
    expect(settenId('AB123D')).toBe('AB123D');    // 末尾が D
    expect(settenId('AB1234D')).toBe('AB1234D');
  });
  it('不一致は空文字', () => {
    expect(settenId('A123')).toBe('');        // 英字が1文字
    expect(settenId('AB12')).toBe('');        // 数字が2桁
    expect(settenId('AB12345')).toBe('');     // 数字が5桁
    expect(settenId('ABCD')).toBe('');        // 数字なし
    expect(settenId('AB123X')).toBe('');      // 末尾が D/数字以外
    expect(settenId('AB123-1 x')).toBe('');   // 余分な文字
    expect(settenId('')).toBe('');
  });
});
