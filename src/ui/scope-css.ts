// overlay 注入時に、アプリの CSS をホストページへ漏らさないためのスコープ付け。
//
// SharePoint ページの上に載るので、`html, body`・`*` のような全体セレクタをそのまま流すと
// ホスト側のレイアウトを壊す。セレクタの先頭に #qam-root を付けて配下に閉じ込める。
// @media 等のブロックはそのまま残し、中のセレクタだけを書き換える。
const ROOT = '#qam-root';

// ホストページ全体に当たるセレクタは、そのままではなく root 自身に読み替える。
const GLOBAL = new Set(['html', 'body', 'html, body', ':root', '*']);

function scopeSelector(sel: string): string {
  return sel.split(',').map((one) => {
    const t = one.trim();
    if (!t) return t;
    if (GLOBAL.has(t)) return ROOT;
    if (t === '#qam-root') return ROOT;
    if (t.startsWith('#qam-root')) return t;
    // [hidden] や [data-theme="dark"] のような属性セレクタは root 自身にも当てたい。
    if (t.startsWith('[')) return `${ROOT}${t}, ${ROOT} ${t}`;
    return `${ROOT} ${t}`;
  }).join(', ');
}

const COMMENT = /\/\*[\s\S]*?\*\//g;

export function scopeCss(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const brace = findBrace(css, i);
    if (brace < 0) { out += css.slice(i); break; }
    // ブロックの手前にはコメントが混ざる。セレクタと一緒に扱うと
    // 「#qam-root /*コメント*/ .x」= 子孫セレクタになって当たらなくなるので、必ず切り離す。
    const head = css.slice(i, brace);
    const comments = head.match(COMMENT) ?? [];
    const sel = head.replace(COMMENT, '').trim();
    const lead = comments.length ? comments.join('\n') + '\n' : '';
    const end = matchBlock(css, brace);
    if (sel.startsWith('@')) {
      // @media / @supports は中身を再帰的に処理。@font-face 等は素通し。
      const body = css.slice(brace + 1, end);
      out += `${lead}${sel} {${/^@(media|supports|layer)/.test(sel) ? scopeCss(body) : body}}`;
    } else if (!sel) {
      out += lead + css.slice(brace, end + 1); // セレクタが読めないものは触らない
    } else {
      out += `${lead}${scopeSelector(sel)} ${css.slice(brace, end + 1)}`;
    }
    i = end + 1;
  }
  return out;
}

// コメントの範囲を飛ばす（コメント内の { } を構文と誤認しないため）。
const skipComment = (css: string, i: number): number => {
  if (!css.startsWith('/*', i)) return i;
  const e = css.indexOf('*/', i + 2);
  return e < 0 ? css.length : e + 1; // 呼び出し側の i++ で '*/' の次へ進む
};

// コメント内を除いた最初の '{' の位置。
function findBrace(css: string, from: number): number {
  for (let i = from; i < css.length; i++) {
    const j = skipComment(css, i);
    if (j !== i) { i = j; continue; }
    if (css[i] === '{') return i;
  }
  return -1;
}

// 対応する閉じ括弧の位置を返す（入れ子・コメント対応）。
function matchBlock(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const j = skipComment(css, i);
    if (j !== i) { i = j; continue; }
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return css.length - 1;
}
