// モーダル（§8/§19）。背景 mousedown 起点でのみ閉じる（リサイズ誤クローズ防止）。
// primary は onPrimary が true を返すまで閉じない（送信失敗時に入力を保持）。
import { el } from './dom';
import { icon } from '../icons';

export interface ModalOpts {
  title: string;
  body: HTMLElement;
  primaryLabel?: string;
  onPrimary?: () => boolean | Promise<boolean>;
  onClose?: () => void;
}

export function openModal(opts: ModalOpts): { close: () => void } {
  const backdrop = el('div', { class: 'qam-backdrop' });
  const box = el('div', { class: 'qam-modal', role: 'dialog', 'aria-modal': 'true' });

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

  let downOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('mouseup', (e) => { if (downOnBackdrop && e.target === backdrop) close(); });
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => close());

  let closed = false;
  function close(): void { if (closed) return; closed = true; backdrop.remove(); document.removeEventListener('keydown', onKey); opts.onClose?.(); }

  backdrop.append(box);
  document.body.append(backdrop);
  (box.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
  return { close };
}
