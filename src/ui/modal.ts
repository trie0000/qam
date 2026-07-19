// モーダル（§8/§19）。背景 mousedown 起点でのみ閉じる（リサイズ誤クローズ防止）。
// primary は onPrimary が true を返すまで閉じない（送信失敗時に入力を保持）。
import { el, uiHost } from './dom';
import { icon } from '../icons';

export interface ModalOpts {
  title: string;
  body: HTMLElement;
  primaryLabel?: string;
  onPrimary?: () => boolean | Promise<boolean>;
  onClose?: () => void;
  // false にすると背景クリックでは閉じない（キャンセル/×/Esc のみ）。
  // 入力量の多いフォームで誤クリック全損を防ぐ。既定 true（従来どおり）。
  dismissBackdrop?: boolean;
  // 2〜3段組を持つ入力フォーム用に横幅を広げる（確認・警告の短いモーダルは既定のまま）。
  wide?: boolean;
}

// 開いているモーダルのスタック。Esc は最前面の 1 枚だけを閉じる
// （確認モーダルの Esc で下のフォームまで一緒に閉じるのを防ぐ）。
const stack: symbol[] = [];

export function openModal(opts: ModalOpts): { close: () => void } {
  const backdrop = el('div', { class: 'qam-backdrop' });
  const box = el('div', { class: `qam-modal${opts.wide ? ' qam-modal--wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });

  const closeBtn = el('button', { class: 'btn btn--icon', 'aria-label': '閉じる', html: icon('x', 16) });
  const head = el('div', { class: 'qam-modal-head' }, [
    el('div', { class: 'qam-modal-title' }, [opts.title]),
    closeBtn,
  ]);
  const bodyWrap = el('div', { class: 'qam-modal-body' }, [opts.body]);
  box.append(head, bodyWrap);

  let primaryBtn: HTMLButtonElement | null = null;
  if (opts.onPrimary) {
    primaryBtn = el('button', { class: 'btn btn--primary' }, [opts.primaryLabel ?? '保存']);
    const cancel = el('button', { class: 'btn btn--ghost' }, ['キャンセル']);
    cancel.addEventListener('click', () => close());
    primaryBtn.addEventListener('click', async () => {
      primaryBtn!.disabled = true;
      try { if (await opts.onPrimary!()) close(); } finally { primaryBtn!.disabled = false; }
    });
    box.append(el('div', { class: 'qam-modal-foot' }, [cancel, primaryBtn]));
  }

  const token = Symbol('modal');
  stack.push(token);
  if (opts.dismissBackdrop !== false) {
    let downOnBackdrop = false;
    backdrop.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === backdrop; });
    backdrop.addEventListener('mouseup', (e) => { if (downOnBackdrop && e.target === backdrop) close(); });
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && stack[stack.length - 1] === token) close();
  };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => close());

  let closed = false;
  function close(): void {
    if (closed) return; closed = true;
    const i = stack.indexOf(token); if (i >= 0) stack.splice(i, 1);
    backdrop.remove(); document.removeEventListener('keydown', onKey); opts.onClose?.();
  }

  backdrop.append(box);
  uiHost().append(backdrop);
  (box.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
  return { close };
}
