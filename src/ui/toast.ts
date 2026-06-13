// トースト（右上・stack・§9）。ok/info は自動消滅、error は手動 dismiss。
import { el, esc } from './dom';
import { icon } from '../icons';

let host: HTMLElement | null = null;
function ensure(): HTMLElement {
  if (!host) { host = el('div', { class: 'qam-toasts' }); document.body.append(host); }
  return host;
}

export function toast(msg: string, kind: 'ok' | 'info' | 'error' = 'info'): void {
  const t = el('div', { class: `qam-toast qam-toast--${kind}` }, [
    el('span', { class: 'qam-toast-msg', html: esc(msg) }),
  ]);
  const close = el('button', { class: 'btn btn--icon', 'aria-label': '閉じる', html: icon('x', 14) });
  close.addEventListener('click', () => t.remove());
  t.append(close);
  ensure().append(t);
  if (kind !== 'error') setTimeout(() => t.remove(), kind === 'ok' ? 2000 : 3000);
}
