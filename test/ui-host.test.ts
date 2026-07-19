import { describe, it, expect, beforeEach } from 'vitest';
import { uiHost } from '../src/ui/dom';

// overlay 注入時、モーダル・トースト・ポップアップを document.body へ直接置くと
// 二重に壊れる（実機で踏んだ）。
//   1. CSS は #qam-root 配下へ閉じ込めてあるので、外に置くと素のまま表示される
//   2. #qam-root は最前面に出しているので、その外側は下に隠れて見えない
// 結果、SharePoint 上では設定も取込もエラー表示も一切見えなくなる。
describe('画面いっぱいに出す UI の置き場所', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('#qam-root があればその中に入れる', () => {
    const root = document.createElement('div');
    root.id = 'qam-root';
    document.body.append(root);
    expect(uiHost()).toBe(root);
  });

  it('#qam-root が無ければ body に落とす（起動前でも落ちない）', () => {
    expect(uiHost()).toBe(document.body);
  });

  it('overlay でも単体ページでも、置き場所は同じ #qam-root になる', () => {
    // 単体ページは HTML に #qam-root があり、overlay は main.ts が作る。
    // どちらも「存在する」ので、呼び出し側はモードを意識しなくてよい。
    const root = document.createElement('div');
    root.id = 'qam-root';
    root.className = 'qam-overlay';
    document.body.append(root);
    const host = uiHost();
    expect(host.id).toBe('qam-root');
    expect(document.body.contains(host)).toBe(true);
  });
});
