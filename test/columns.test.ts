import { describe, it, expect } from 'vitest';
import { settenId } from '../src/ui/columns';

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
