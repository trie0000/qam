// 資産一覧 / 変更履歴 の列定義（共通テーブル §25 用）。
import { el, esc, clear } from './dom';
import { icon } from '../icons';
import { openModal } from './modal';
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

// 手動メタ情報（API で取れない Function/Location 等を一覧から手入力）。
export interface AnnotApi {
  get: (id: string, field: string) => string;
  save: (id: string, field: string, value: string) => Promise<void>;
}

// その場編集セル（1行テキスト）。フォーカスを外すと保存・Escで取消・Enterで確定。
function editableCell(initial: string, placeholder: string, onSave: (v: string) => Promise<void>): HTMLElement {
  const cell = el('div', { class: 'qam-edit-cell' });
  let current = initial;
  function view(): void {
    clear(cell);
    const v = el('div', { class: 'qam-edit-view' + (current ? '' : ' is-empty'), title: current || placeholder }, [current || placeholder]);
    v.addEventListener('click', (e) => { e.stopPropagation(); edit(); });
    cell.append(v);
  }
  function edit(): void {
    clear(cell);
    const inp = el('input', { type: 'text', class: 'qam-edit-in', placeholder }) as HTMLInputElement;
    inp.value = current;
    inp.addEventListener('click', (e) => e.stopPropagation());
    let closed = false;
    const finish = async (commit: boolean): Promise<void> => {
      if (closed) return; closed = true;
      const v = inp.value.trim();
      if (commit && v !== current) { try { await onSave(v); current = v; } catch { /* 失敗時は表示に戻す */ } }
      view();
    };
    inp.addEventListener('blur', () => { void finish(true); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); inp.blur(); }
    });
    cell.append(inp); inp.focus();
  }
  view();
  return cell;
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

// agSetten: host ID / domain名 → 所属AssetGroupの接続点ID（カンマ区切り全件）。host/domain 用。
// annot: API で取れない項目の手入力（Function/Location）。group 用。
export function assetColumns(entity: QamEntity, comments: CommentApi, agSetten: Record<string, string> = {}, annot?: AnnotApi): Column[] {
  const c = (id: string, label: string, render: (r: QamRecord) => string | Node, mono?: boolean): Column => ({ id, label, mono, render, sortVal: (r) => String((render(r) as any)).toString() });
  const sc = (f: string) => (r: QamRecord) => esc(r.scalar[f] ?? '');
  const stc = (f: string) => (r: QamRecord) => joined(r.set[f]);
  // 手入力列（その場編集）。値が無ければスナップショットの値、なければ空。並べ替え/出力は文字値で。
  const editCol = (id: string, label: string, field: string): Column => ({
    id, label,
    render: (r: QamRecord) => (annot
      ? editableCell(annot.get(r.key, field) || (r.scalar[field] ?? ''), '（クリックで入力）', (v) => annot.save(r.key, field, v))
      : esc(r.scalar[field] ?? '')),
    sortVal: (r: QamRecord) => (annot ? (annot.get(r.key, field) || (r.scalar[field] ?? '')) : (r.scalar[field] ?? '')),
  });
  const comment: Column = { id: '_c', label: 'メモ', sortable: false, render: (r: QamRecord) => commentCell(entity, r.key, comments), sortVal: (r: QamRecord) => latestText(comments, r.key) };
  if (entity === 'group') return [
    c('key', 'ID', (r) => esc(r.key), true), c('name', 'タイトル', (r) => esc(r.name)),
    c('SETTEN', '接続点ID', (r) => esc(settenId(r.name)), true),
    c('OWNER_ID', 'オーナーID', sc('OWNER_ID'), true), c('IPS', 'IP', stc('IPS')),
    c('DNS_LIST', 'DNS', stc('DNS_LIST')), c('DOMAIN_LIST', 'ドメイン', stc('DOMAIN_LIST')),
    editCol('DIVISION', '事業場名(Division)', 'DIVISION'), editCol('FUNCTION', '接続名称(Function)', 'FUNCTION'),
    editCol('LOCATION', '拠点名称(Location)', 'LOCATION'), editCol('COMMENTS', 'コメント(Comments)', 'COMMENTS'),
    c('LAST_UPDATE', '最終更新', (r) => esc(r.info.LAST_UPDATE ?? ''), true), comment,
  ];
  if (entity === 'host') return [
    c('key', 'ID', (r) => esc(r.key), true), c('name', 'FQDN', (r) => esc(r.name)),
    c('AG_SETTEN', '接続点ID', (r) => esc(agSetten[r.key] ?? ''), true),
    c('IP', 'IP', sc('IP'), true), c('OS', 'OS', sc('OS')),
    c('TRACKING_METHOD', '追跡', sc('TRACKING_METHOD')), c('NETBIOS', 'NetBIOS', sc('NETBIOS')),
    c('LAST_VULN_SCAN_DATETIME', '最終スキャン', (r) => esc(r.info.LAST_VULN_SCAN_DATETIME ?? ''), true), comment,
  ];
  if (entity === 'user') return [
    c('key', 'ユーザID', (r) => esc(r.key), true), c('USER_LOGIN', 'ログイン', sc('USER_LOGIN'), true),
    c('NAME', '氏名', sc('NAME')), c('EMAIL', 'メール', sc('EMAIL')),
    c('USER_ROLE', 'ロール', sc('USER_ROLE')), c('USER_STATUS', '状態', sc('USER_STATUS')),
    c('TITLE', '役職', sc('TITLE')),
    c('SCOPE_TAGS', 'スコープ(タグ)', stc('SCOPE_TAGS')),
    c('ASSIGNED_GROUPS', 'アクセス可能AG', stc('ASSIGNED_GROUPS')),
    c('LAST_LOGIN_DATE', '最終ログイン', (r) => esc(r.info.LAST_LOGIN_DATE ?? ''), true), comment,
  ];
  return [
    c('key', 'ドメイン名', (r) => esc(r.key)),
    c('AG_SETTEN', '接続点ID', (r) => esc(agSetten[r.key] ?? ''), true),
    c('NETWORK_NAME', 'ネットワーク', sc('NETWORK_NAME')),
    c('NETBLOCK', 'ネットブロック', stc('NETBLOCK')), comment,
  ];
}

// 種別ごとに ID/名前 のラベルを資産一覧と合わせる（汎用の「ID/名前」をやめる）。
const HIST_ID_LABEL: Record<QamEntity, string> = { group: 'AssetGroup ID', host: 'Host ID', domain: 'ドメイン名', user: 'ユーザID' };
const HIST_NAME_LABEL: Record<QamEntity, string> = { group: 'タイトル', host: 'FQDN', domain: '名前', user: '氏名' };

// 削除プロパティ表示のフィールド名→ラベル（資産一覧の列ラベルと揃える）。
const FIELD_LABELS: Record<string, string> = {
  OWNER_ID: 'オーナーID', IPS: 'IP', DNS_LIST: 'DNS', DOMAIN_LIST: 'ドメイン',
  DIVISION: '事業場名(Division)', FUNCTION: '接続名称(Function)', LOCATION: '拠点名称(Location)', COMMENTS: 'コメント(Comments)',
  LAST_UPDATE: '最終更新',
  IP: 'IP', OS: 'OS', TRACKING_METHOD: '追跡', NETBIOS: 'NetBIOS', LAST_VULN_SCAN_DATETIME: '最終スキャン',
  USER_LOGIN: 'ログイン', NAME: '氏名', EMAIL: 'メール', USER_ROLE: 'ロール', USER_STATUS: '状態', TITLE: '役職',
  SCOPE_TAGS: 'スコープ(タグ)', ASSIGNED_GROUPS: 'アクセス可能AG', LAST_LOGIN_DATE: '最終ログイン',
  NETWORK_NAME: 'ネットワーク', NETBLOCK: 'ネットブロック',
};
const fieldLabel = (entity: QamEntity, k: string): string =>
  k === 'name' ? HIST_NAME_LABEL[entity] : k === 'key' ? HIST_ID_LABEL[entity] : (FIELD_LABELS[k] ?? k);

// 削除資産のプロパティをプロパティシート風（ラベル｜値）にモーダル表示。
function openDeletedProps(e: QamEvent): void {
  const body = el('div', { class: 'qam-props' });
  body.append(el('div', { class: 'qam-props-head' }, [
    el('span', { class: 'qam-tag qam-tag--deleted' }, ['削除']),
    el('span', { class: 'qam-props-id' }, [`${HIST_ID_LABEL[e.entity]}: ${e.id}`]),
  ]));
  const rows = e.props ?? [];
  for (const p of rows) {
    body.append(el('div', { class: 'qam-prop-row' }, [
      el('div', { class: 'qam-prop-k' }, [fieldLabel(e.entity, p.k)]),
      el('div', { class: 'qam-prop-v', title: p.v }, [p.v]),
    ]));
  }
  openModal({ title: `削除資産のプロパティ — ${e.name || e.id}`, body });
}

// agSetten: host ID → 所属AGの接続点ID（host履歴用、main から渡す）。group はタイトルから算出。
export function historyColumns(entity: QamEntity, comments: CommentApi, agSetten: Record<string, string> = {}): Column[] {
  // 削除イベントは「変更前/削除」セルに削除資産のプロパティを開くボタンを出す（記録があれば）。
  const oldCell = (e: QamEvent): string | Node => {
    if (e.change === 'deleted' && e.props?.length) {
      const btn = el('button', { class: 'qam-prop-btn', html: `${icon('file', 12)}<span>プロパティを表示</span>` });
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); openDeletedProps(e); });
      return btn;
    }
    return e.removed?.length ? `<span class="qam-rem">− ${joined(e.removed)}</span>` : esc(e.old ?? '');
  };
  const newCell = (e: QamEvent): string => e.added?.length ? `<span class="qam-add">+ ${joined(e.added)}</span>` : esc(e.new ?? '');
  // 接続点ID: group はタイトル(e.name)から算出、host は所属AGの接続点ID(agSetten[e.id])。
  const settenOf = (e: QamEvent): string => (entity === 'group' ? settenId(e.name) : (agSetten[e.id] ?? ''));
  const cols: Column[] = [
    { id: 'ts', label: '更新日', mono: true, render: (e: QamEvent) => esc(fmtStamp(e.ts)), sortVal: (e: QamEvent) => e.ts },
    { id: 'change', label: '種別', render: (e: QamEvent) => changeTag(e.change), sortVal: (e: QamEvent) => CHANGE_LABEL[e.change] ?? e.change },
    { id: 'id', label: HIST_ID_LABEL[entity], mono: true, render: (e: QamEvent) => esc(e.id), sortVal: (e: QamEvent) => e.id },
    { id: 'name', label: HIST_NAME_LABEL[entity], render: (e: QamEvent) => esc(e.name) },
    { id: 'field', label: '変更項目', render: (e: QamEvent) => esc(e.field ?? ''), sortVal: (e: QamEvent) => e.field ?? '' },
    { id: 'old', label: '変更前/削除', render: oldCell, sortable: false },
    { id: 'new', label: '変更後/追加', render: newCell, sortable: false },
    { id: '_c', label: 'メモ', sortable: false, render: (e: QamEvent) => commentCell(e.entity, e.id, comments), sortVal: (e: QamEvent) => latestText(comments, e.id) },
  ];
  // AssetGroup / Host は接続点ID列を「名前」の直後に挿入。
  if (entity === 'group' || entity === 'host') {
    cols.splice(4, 0, { id: 'setten', label: '接続点ID', mono: true, render: (e: QamEvent) => esc(settenOf(e)), sortVal: settenOf });
  }
  return cols;
}
