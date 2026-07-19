import { describe, it, expect } from 'vitest';
import { scopeCss } from '../src/ui/scope-css';

// overlay 注入時、アプリの CSS がホストページ（SharePoint）へ漏れないことを担保する。
// ここが崩れると、注入した瞬間に SP のページレイアウトが壊れる。
describe('overlay 用の CSS スコープ付け', () => {
  it('ホストページ全体に当たるセレクタは root 自身へ読み替える', () => {
    expect(scopeCss('html, body { height: 100%; }')).toContain('#qam-root {');
    expect(scopeCss('* { box-sizing: border-box; }')).toContain('#qam-root {');
    expect(scopeCss(':root { --ink: #000; }')).toContain('#qam-root {');
    // body の指定がホストに漏れない
    expect(scopeCss('body { margin: 0; }')).not.toMatch(/(^|[^-\w])body\s*\{/);
  });

  it('通常のセレクタは root 配下へ閉じ込める', () => {
    expect(scopeCss('.qam-app { display: grid; }')).toBe('#qam-root .qam-app { display: grid; }');
    expect(scopeCss('.a, .b { color: red; }')).toBe('#qam-root .a, #qam-root .b { color: red; }');
  });

  it('#qam-root への指定は二重に付けない', () => {
    expect(scopeCss('#qam-root { height: 100%; }')).toBe('#qam-root { height: 100%; }');
    expect(scopeCss('#qam-root .x { color: red; }')).toBe('#qam-root .x { color: red; }');
  });

  it('属性セレクタは root 自身と配下の両方に効かせる', () => {
    // [hidden] や [data-theme] は root 自身にも当てたい（テーマ切替が効かなくなるため）
    const out = scopeCss('[hidden] { display: none !important; }');
    expect(out).toContain('#qam-root[hidden]');
    expect(out).toContain('#qam-root [hidden]');
  });

  it('@media の中身も同じ規則で処理する', () => {
    const out = scopeCss('@media (max-width: 600px) { .x { color: red; } }');
    expect(out).toContain('@media (max-width: 600px) {');
    expect(out).toContain('#qam-root .x { color: red; }');
  });

  it('コメントと入れ子ブロックを壊さない', () => {
    const css = '/* コメント { } */\n.a { color: red; }';
    const out = scopeCss(css);
    expect(out).toContain('/* コメント { } */');
    expect(out).toContain('#qam-root .a');
  });

  it('セレクタ直前のコメントを巻き込まない（子孫セレクタ化を防ぐ）', () => {
    // 巻き込むと `#qam-root /*c*/ .x` = 子孫セレクタになり、root 自身に当てたい指定が効かなくなる。
    const out = scopeCss('/* 説明 */\n#qam-root.qam-overlay { position: fixed; }');
    expect(out).toContain('#qam-root.qam-overlay {');
    expect(out).not.toContain('#qam-root /*');
  });

  it('root 自身に当てる指定は子孫にしない', () => {
    expect(scopeCss('#qam-root.qam-overlay { inset: 0; }')).toBe('#qam-root.qam-overlay { inset: 0; }');
  });

  it('実際の app.css 相当を通しても body/html が生で残らない', () => {
    const css = `:root { --ink: #000; }
[data-theme="dark"] { --ink: #fff; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font-family: sans-serif; }
#qam-root { height: 100%; }
.qam-app { display: grid; }`;
    const out = scopeCss(css);
    for (const line of out.split('\n')) {
      const sel = line.split('{')[0].trim();
      if (!sel || sel.startsWith('/*')) continue;
      expect(sel.startsWith('#qam-root')).toBe(true);
    }
  });
});
