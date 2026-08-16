// DOM ユーティリティ。el() で生成、IME ガード付き Enter ハンドラ等。
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

export type Attrs = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'html') e.innerHTML = String(v);
      else if (k === 'dataset') Object.assign(e.dataset, v as object);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
      else e.setAttribute(k, String(v));
    }
  }
  if (children) for (const c of children) e.append(c);
  return e;
}

export const clear = (e: Element): void => { while (e.firstChild) e.removeChild(e.firstChild); };

/**
 * 画面いっぱいに出す UI（モーダル・トースト・ポップアップ）の置き場所。
 *
 * overlay 注入時に document.body へ直接置くと二重に壊れる。
 *   1. CSS は #qam-root 配下へ閉じ込めてあるので、外に置くと**素のまま**表示される
 *   2. #qam-root は最前面に出しているので、その外側は**下に隠れて見えない**
 * どちらのモードでも #qam-root は存在するので、常にその中へ入れる。
 *
 * overlay では #qam-root を Shadow DOM の中に置く。document からは辿れないので、
 * 起動時に setUiRoot() で実体を渡してもらい、以降はそれを使う。
 */
let uiRootEl: HTMLElement | null = null;
let uiScope: ParentNode | null = null;

export function setUiRoot(scope: ParentNode, root: HTMLElement): void {
  uiScope = scope; uiRootEl = root;
}

export const uiHost = (): HTMLElement => uiRootEl ?? document.getElementById('qam-root') ?? document.body;

/** アプリ自身の要素を探す。Shadow DOM 内は document から見えないため、必ずこれを使う。 */
export const uiQuery = <T extends Element = HTMLElement>(sel: string): T | null =>
  ((uiScope ?? document) as ParentNode).querySelector<T>(sel);

/**
 * 座標上の要素。document から引くと shadow の中は見えず、ホスト要素しか返らない
 * （スクロール対象や列ドラッグ先の判定が全部外れる）。shadow のときはそちらから引く。
 */
export function uiElementFromPoint(x: number, y: number): HTMLElement | null {
  const scope = uiScope;
  const from: DocumentOrShadowRoot = scope && scope !== document && typeof (scope as ShadowRoot).elementFromPoint === 'function'
    ? (scope as ShadowRoot) : document;
  return from.elementFromPoint(x, y) as HTMLElement | null;
}

/**
 * document レベルの listener で本当のイベント発生元を取る。
 * shadow の外へ出たイベントは target がホスト要素に付け替わる（retarget）ため、
 * e.target で入力欄かどうかを見ると必ず外れる。
 */
export const uiEventTarget = (e: Event): HTMLElement | null =>
  ((e.composedPath?.()[0] as HTMLElement | undefined) ?? (e.target as HTMLElement | null)) ?? null;

// Enter 確定ハンドラ。IME 変換中は必ず除外（UIルール §6）。
export function onEnter(input: HTMLElement, fn: () => void): void {
  input.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); }
  });
}
