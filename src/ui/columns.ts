// 資産一覧 / 変更履歴 の列定義（共通テーブル §25 用）。
import { el, esc, clear } from './dom';
import { icon } from '../icons';
import { fmtStamp } from '../config';
import type { Column } from './table';
import type { QamComment, QamEntity, QamEvent, QamRecord } from '../types';

const CHANGE_LABEL: Record<string, string> = { added: '追加', modified: '変更', deleted: '削除' };
export const changeTag = (c: string): string => `<span class="qam-tag qam-tag--${c}">${CHANGE_LABEL[c] ?? c}</span>`;

const joined = (a?: string[]): string => esc((a ?? []).join(', '));

// 接続点ID: AssetGroup タイトルの先頭〜最初の半角スペースまでを切り出す。
// 有効なのは「先頭2文字が英字 + 数字3〜4桁 + 末尾は D または数字」の形のみ（不一致は空）。
const SETTEN_RE = /^[A-Za-z]{2}\d{3,4}D?$/;
export const settenId = (title: string): string => { const t = (title || '').split(' ')[0]; return SETTEN_RE.test(t) ? t : ''; };

// その資産の最新コメント本文（無ければ空）。フィルタ・並べ替え・エクスポートの照合に使う。
const latestText = (api: CommentApi, id: string): string => {
  const l = api.byId[id] ?? [];
  return l.length ? l[l.length - 1].text : '';
};

// 一覧のコメント列に渡すAPI。byId は id→コメント配列(ts昇順)。save は ts指定で編集/null で新規追加し、
// 更新後の配列を返す。openThread は従来のスレッドモーダル（履歴閲覧・追記）。
export interface CommentApi {
  byId: Record<string, QamComment[]>;
  openThread: (e: QamEntity, id: string) => void;
  save: (e: QamEntity, id: string, ts: string | null, text: string) => Promise<QamComment[]>;
}

// コメントセル: 最新コメントを一覧内に直接表示し、クリックでその場編集（最新を編集／無ければ新規）。
// 右側のスレッドボタン（件数）で全作業履歴モーダルを開く（追記もそこから）。
function commentCell(entity: QamEntity, id: string, api: CommentApi): HTMLElement {
  const cell = el('div', { class: 'qam-comment-cell' });
  const stop = (e: Event) => e.stopPropagation();

  function view(): void {
    clear(cell);
    const list = api.byId[id] ?? [];
    const latest = list.length ? list[list.length - 1] : null;
    const text = el('div', { class: 'qam-comment-view' + (latest ? '' : ' is-empty'), title: latest ? latest.text : 'クリックしてメモを追加' }, [latest ? latest.text : '＋ メモ']);
    text.addEventListener('click', (e) => { stop(e); edit(latest); });
    const thread = el('button', { class: 'qam-comment-thread', title: '作業履歴を開く', html: `${icon('message', 13)}<span>${list.length || ''}</span>` });
    thread.addEventListener('click', (e) => { stop(e); api.openThread(entity, id); });
    cell.append(text, el('div', { class: 'qam-comment-tools' }, [thread]));
  }

  function edit(latest: QamComment | null): void {
    clear(cell);
    const ta = el('textarea', { class: 'qam-comment-edit', placeholder: 'メモ（フォーカスを外すと保存・Escで取消）' }) as HTMLTextAreaElement;
    ta.value = latest?.text ?? '';
    ta.addEventListener('click', stop);
    // ボタンは置かず、フォーカスを外したら自動保存。Esc で取消、⌘/Ctrl+Enter で確定(=blur)。
    let closed = false;
    const finish = async (commit: boolean): Promise<void> => {
      if (closed) return; closed = true;
      const t = ta.value.trim();
      if (commit && t && t !== (latest?.text ?? '')) {
        try { api.byId[id] = await api.save(entity, id, latest?.ts ?? null, t); } catch { /* 失敗時は表示に戻すだけ */ }
      }
      view();
    };
    ta.addEventListener('blur', () => { void finish(true); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
      else if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ta.blur(); }
    });
    cell.append(ta);
    ta.focus();
  }

  view();
  return cell;
}

export function assetColumns(entity: QamEntity, comments: CommentApi): Column[] {
  const c = (id: string, label: string, render: (r: QamRecord) => string | Node, mono?: boolean): Column => ({ id, label, mono, render, sortVal: (r) => String((render(r) as any)).toString() });
  const sc = (f: string) => (r: QamRecord) => esc(r.scalar[f] ?? '');
  const stc = (f: string) => (r: QamRecord) => joined(r.set[f]);
  const comment: Column = { id: '_c', label: 'コメント', sortable: false, render: (r: QamRecord) => commentCell(entity, r.key, comments), sortVal: (r: QamRecord) => latestText(comments, r.key) };
  if (entity === 'group') return [
    c('key', 'ID', (r) => esc(r.key), true), c('name', 'タイトル', (r) => esc(r.name)),
    c('SETTEN', '接続点ID', (r) => esc(settenId(r.name)), true),
    c('OWNER_ID', 'オーナーID', sc('OWNER_ID'), true), c('IPS', 'IP', stc('IPS')),
    c('DNS_LIST', 'DNS', stc('DNS_LIST')), c('DOMAIN_LIST', 'ドメイン', stc('DOMAIN_LIST')),
    c('DIVISION', '部門(Division)', sc('DIVISION')), c('FUNCTION', '機能(Function)', sc('FUNCTION')),
    c('LOCATION', 'ロケーション(Location)', sc('LOCATION')), c('COMMENTS', 'コメント', sc('COMMENTS')),
    c('LAST_UPDATE', '最終更新', (r) => esc(r.info.LAST_UPDATE ?? ''), true), comment,
  ];
  if (entity === 'host') return [
    c('key', 'ID', (r) => esc(r.key), true), c('name', 'FQDN', (r) => esc(r.name)),
    c('IP', 'IP', sc('IP'), true), c('OS', 'OS', sc('OS')),
    c('TRACKING_METHOD', '追跡', sc('TRACKING_METHOD')), c('NETBIOS', 'NetBIOS', sc('NETBIOS')),
    c('LAST_VULN_SCAN_DATETIME', '最終スキャン', (r) => esc(r.info.LAST_VULN_SCAN_DATETIME ?? ''), true), comment,
  ];
  if (entity === 'user') return [
    c('key', 'ユーザID', (r) => esc(r.key), true), c('USER_LOGIN', 'ログイン', sc('USER_LOGIN'), true),
    c('NAME', '氏名', sc('NAME')), c('EMAIL', 'メール', sc('EMAIL')),
    c('USER_ROLE', 'ロール', sc('USER_ROLE')), c('USER_STATUS', '状態', sc('USER_STATUS')),
    c('TITLE', '役職', sc('TITLE')),
    c('LAST_LOGIN_DATE', '最終ログイン', (r) => esc(r.info.LAST_LOGIN_DATE ?? ''), true), comment,
  ];
  return [
    c('key', 'ドメイン', (r) => esc(r.key)), c('NETWORK_NAME', 'ネットワーク', sc('NETWORK_NAME')),
    c('NETBLOCK', 'ネットブロック', stc('NETBLOCK')), comment,
  ];
}

export function historyColumns(comments: CommentApi): Column[] {
  const oldCell = (e: QamEvent): string => e.removed?.length ? `<span class="qam-rem">− ${joined(e.removed)}</span>` : esc(e.old ?? '');
  const newCell = (e: QamEvent): string => e.added?.length ? `<span class="qam-add">+ ${joined(e.added)}</span>` : esc(e.new ?? '');
  return [
    { id: 'ts', label: '取込日時', mono: true, render: (e: QamEvent) => esc(fmtStamp(e.ts)), sortVal: (e: QamEvent) => e.ts },
    { id: 'change', label: '種別', render: (e: QamEvent) => changeTag(e.change), sortVal: (e: QamEvent) => e.change },
    { id: 'id', label: 'ID', mono: true, render: (e: QamEvent) => esc(e.id), sortVal: (e: QamEvent) => e.id },
    { id: 'name', label: '名前', render: (e: QamEvent) => esc(e.name) },
    { id: 'field', label: '項目', render: (e: QamEvent) => esc(e.field ?? ''), sortVal: (e: QamEvent) => e.field ?? '' },
    { id: 'old', label: '変更前/削除', render: oldCell, sortable: false },
    { id: 'new', label: '変更後/追加', render: newCell, sortable: false },
    { id: '_c', label: 'コメント', sortable: false, render: (e: QamEvent) => commentCell(e.entity, e.id, comments), sortVal: (e: QamEvent) => latestText(comments, e.id) },
  ];
}
