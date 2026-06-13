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

// Enter 確定ハンドラ。IME 変換中は必ず除外（UIルール §6）。
export function onEnter(input: HTMLElement, fn: () => void): void {
  input.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); }
  });
}
