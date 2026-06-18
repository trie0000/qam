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

// ISO UTC（例 2024-06-13T08:30:00Z）→ JST 表示 'YYYY-MM-DD HH:MM:SS JST'。
// 日本は夏時間なしなので UTC+9 固定。端末のタイムゾーンに依存しないよう getUTC* で組み立てる。
// パースできない/空はそのまま返す。
export function fmtJst(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())} JST`;
}

// 接続点ID: AssetGroup タイトルの先頭〜最初の半角スペースまでを切り出す（形式ルールは設けない）。
export const settenId = (title: string): string => (title || '').split(' ')[0];

// その資産の最新コメント本文（無ければ空）。フィルタ・並べ替え・エクスポートの照合に使う。
const latestText = (api: CommentApi, id: string): string => {
  const l = api.byId[id] ?? [];
  return l.length ? l[l.length - 1].text : '';
};

// 一覧のコメント列に渡すAPI。byId は id→コメント配列(ts昇順)。save は ts指定で編集/null で新規追加し、
// 更新後の配列を返す（一覧セル内のその場編集のみ。スレッドモーダルは廃止）。
export interface CommentApi {
  byId: Record<string, QamComment[]>;
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
    // 空文字メモ（＝ブランク化済み）は本文なし扱いでプレースホルダを表示。編集時は latest の ts を引き継ぐ。
    const hasText = !!(latest && latest.text);
    const text = el('div', { class: 'qam-comment-view' + (hasText ? '' : ' is-empty'), title: hasText ? latest!.text : 'クリックしてメモを追加' }, [hasText ? latest!.text : '＋ メモ']);
    text.addEventListener('click', (e) => { stop(e); edit(latest); });
    cell.append(text);
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
      const prev = latest?.text ?? '';
      // 既存メモの編集なら空文字も保存してブランク化を許可（新規は空なら作らない）。
      if (commit && t !== prev && (latest || t)) {
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
  // 並びは既定表示順。既定で隠す列（ASSET_DEFAULT_HIDDEN）は末尾に置く。
  if (entity === 'group') return [
    c('SETTEN', '接続点ID', (r) => esc(settenId(r.name)), true), c('name', 'タイトル', (r) => esc(r.name)),
    editCol('DIVISION', '事業場名(Division)', 'DIVISION'), editCol('FUNCTION', '接続名称(Function)', 'FUNCTION'),
    editCol('LOCATION', '拠点名称(Location)', 'LOCATION'),
    c('IPS', 'IP', stc('IPS')), c('DNS_LIST', 'DNS', stc('DNS_LIST')),
    editCol('COMMENTS', 'コメント(Comments)', 'COMMENTS'),
    c('LAST_UPDATE', '最終更新', (r) => esc(fmtJst(r.info.LAST_UPDATE ?? '')), true), comment,
    // 既定非表示
    c('key', 'ID', (r) => esc(r.key), true), c('OWNER_ID', 'オーナーID', sc('OWNER_ID'), true),
    c('DOMAIN_LIST', 'ドメイン', stc('DOMAIN_LIST')), editCol('EXT_CONN_NO', '外接番号', 'EXT_CONN_NO'),
  ];
  if (entity === 'host') return [
    c('AG_SETTEN', '接続点ID', (r) => esc(agSetten[r.key] ?? ''), true),
    c('IP', 'IP', sc('IP'), true), c('name', 'FQDN', (r) => esc(r.name)),
    c('TRACKING_METHOD', 'Tracking', sc('TRACKING_METHOD')),
    c('LAST_VULN_SCAN_DATETIME', '最終スキャン', (r) => esc(fmtJst(r.info.LAST_VULN_SCAN_DATETIME ?? '')), true), comment,
    // 既定非表示
    c('key', 'ID', (r) => esc(r.key), true), c('OS', 'OS', sc('OS')), c('NETBIOS', 'NetBIOS', sc('NETBIOS')),
  ];
  if (entity === 'user') return [
    c('key', 'ユーザID', (r) => esc(r.key), true), c('USER_LOGIN', 'ログイン', sc('USER_LOGIN'), true),
    c('NAME', '氏名', sc('NAME')), c('EMAIL', 'メール', sc('EMAIL')),
    c('USER_ROLE', 'ロール', sc('USER_ROLE')), c('USER_STATUS', '状態', sc('USER_STATUS')),
    c('TITLE', '役職', sc('TITLE')),
    c('SCOPE_TAGS', 'スコープ(タグ)', stc('SCOPE_TAGS')),
    c('ASSIGNED_GROUPS', 'アクセス可能AG', stc('ASSIGNED_GROUPS')),
    c('LAST_LOGIN_DATE', '最終ログイン', (r) => esc(fmtJst(r.info.LAST_LOGIN_DATE ?? '')), true), comment,
  ];
  return [
    c('key', 'ドメイン名', (r) => esc(r.key)),
    c('AG_SETTEN', '接続点ID', (r) => esc(agSetten[r.key] ?? ''), true),
    c('NETBLOCK', 'ネットブロック', stc('NETBLOCK')), comment,
    // 既定非表示
    c('NETWORK_NAME', 'ネットワーク', sc('NETWORK_NAME')),
  ];
}

// 既定で隠す列（一覧）。ユーザーは「列表示」でいつでも表示できる。
export const ASSET_DEFAULT_HIDDEN: Record<QamEntity, string[]> = {
  group: ['key', 'OWNER_ID', 'DOMAIN_LIST', 'EXT_CONN_NO'],
  host: ['key', 'OS', 'NETBIOS'],
  domain: ['NETWORK_NAME'],
  user: [],
};

// 種別ごとに ID/名前 のラベルを資産一覧と合わせる（汎用の「ID/名前」をやめる）。
const HIST_ID_LABEL: Record<QamEntity, string> = { group: 'AssetGroup ID', host: 'Host ID', domain: 'ドメイン名', user: 'ユーザID' };
const HIST_NAME_LABEL: Record<QamEntity, string> = { group: 'タイトル', host: 'FQDN', domain: '名前', user: '氏名' };

// 削除プロパティ表示のフィールド名→ラベル（資産一覧の列ラベルと揃える）。
const FIELD_LABELS: Record<string, string> = {
  OWNER_ID: 'オーナーID', IPS: 'IP', DNS_LIST: 'DNS', DOMAIN_LIST: 'ドメイン',
  EXT_CONN_NO: '外接番号',
  DIVISION: '事業場名(Division)', FUNCTION: '接続名称(Function)', LOCATION: '拠点名称(Location)', COMMENTS: 'コメント(Comments)',
  LAST_UPDATE: '最終更新',
  IP: 'IP', OS: 'OS', TRACKING_METHOD: '追跡', NETBIOS: 'NetBIOS', LAST_VULN_SCAN_DATETIME: '最終スキャン',
  USER_LOGIN: 'ログイン', NAME: '氏名', EMAIL: 'メール', USER_ROLE: 'ロール', USER_STATUS: '状態', TITLE: '役職',
  SCOPE_TAGS: 'スコープ(タグ)', ASSIGNED_GROUPS: 'アクセス可能AG', LAST_LOGIN_DATE: '最終ログイン',
  NETWORK_NAME: 'ネットワーク', NETBLOCK: 'ネットブロック',
};
const fieldLabel = (entity: QamEntity, k: string): string =>
  k === 'name' ? HIST_NAME_LABEL[entity] : k === 'key' ? HIST_ID_LABEL[entity] : (FIELD_LABELS[k] ?? k);

// 変更履歴イベントの資産情報をプロパティシート風（ラベル｜値）にモーダル表示（行クリックで開く）。
// 追加/削除イベントは取込時に記録した資産スナップショット(props)を、変更イベントは変更項目の前後を出す。
export function openEventProps(e: QamEvent): void {
  const body = el('div', { class: 'qam-props' });
  body.append(el('div', { class: 'qam-props-head' }, [
    el('span', { class: `qam-tag qam-tag--${e.change}` }, [CHANGE_LABEL[e.change] ?? e.change]),
    el('span', { class: 'qam-props-id' }, [`${HIST_ID_LABEL[e.entity]}: ${e.id}`]),
  ]));
  const propRow = (k: string, v: string): HTMLElement => el('div', { class: 'qam-prop-row' }, [
    el('div', { class: 'qam-prop-k' }, [k]),
    el('div', { class: 'qam-prop-v', title: v }, [v]),
  ]);
  if (e.props?.length) {
    // 追加/削除: 記録済みの資産スナップショット
    for (const p of e.props) body.append(propRow(fieldLabel(e.entity, p.k), p.v));
  } else if (e.change === 'modified') {
    // 変更: 名前＋変更項目の前後
    body.append(propRow(HIST_NAME_LABEL[e.entity], e.name || ''));
    if (e.field) body.append(propRow('変更項目', fieldLabel(e.entity, e.field)));
    const before = e.removed?.length ? e.removed.join(', ') : (e.old ?? '');
    const after = e.added?.length ? e.added.join(', ') : (e.new ?? '');
    body.append(propRow('変更前', before), propRow('変更後', after));
  } else {
    // props 未記録（この機能の導入前 / CSV取込の履歴）
    body.append(propRow(HIST_NAME_LABEL[e.entity], e.name || ''));
    body.append(el('div', { class: 'qam-callout', style: 'margin-top:var(--s-3)' }, [
      el('span', { html: icon('alert', 13) }),
      el('span', {}, ['この履歴には資産スナップショットが記録されていません（機能導入前、またはCSV取込の履歴）。']),
    ]));
  }
  const label = CHANGE_LABEL[e.change] ?? e.change;
  openModal({ title: `${label}アセットの情報 — ${e.name || e.id}`, body });
}

// agSetten: host ID → 所属AGの接続点ID（host履歴用・現スナップショット由来）。group はタイトルから算出。
// agIdSetten: AssetGroup ID → 接続点ID。削除済みhostは props の ASSET_GROUP_IDS をこれで接続点IDに変換する。
export function historyColumns(entity: QamEntity, comments: CommentApi, agSetten: Record<string, string> = {}, agIdSetten: Record<string, string> = {}): Column[] {
  // 専用列(追加/削除IP・DNS・FQDN)を持つ項目は 変更前/変更後 に重複表示しない。
  const dedicatedFields: string[] = entity === 'group' ? ['IPS', 'DNS_LIST'] : entity === 'host' ? ['IP', 'FQDN'] : entity === 'domain' ? ['NETBLOCK'] : [];
  const isDedicated = (e: QamEvent): boolean => !!e.field && dedicatedFields.includes(e.field);
  // 資産情報は行クリックで開く（openEventProps）。ここは変更前/削除値の表示のみ（専用列項目は空）。
  const oldCell = (e: QamEvent): string => isDedicated(e) ? '' : (e.removed?.length ? `<span class="qam-rem">− ${joined(e.removed)}</span>` : esc(e.old ?? ''));
  const newCell = (e: QamEvent): string => isDedicated(e) ? '' : (e.added?.length ? `<span class="qam-add">+ ${joined(e.added)}</span>` : esc(e.new ?? ''));
  const propVal = (e: QamEvent, k: string): string => e.props?.find((p) => p.k === k)?.v ?? '';
  // props の所属AG → 接続点ID（重複除き昇順）。削除済みhostの所属AG復元用。
  // ASSET_GROUP_TITLES があればタイトルから直接、無ければ ASSET_GROUP_IDS を agIdSetten で変換。
  const settenFromProps = (e: QamEvent): string => {
    const titles = propVal(e, 'ASSET_GROUP_TITLES').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = propVal(e, 'ASSET_GROUP_IDS').split(',').map((s) => s.trim()).filter(Boolean);
    const sids = [...new Set([...titles.map((t) => settenId(t)), ...ids.map((id) => agIdSetten[id])].filter(Boolean))].sort();
    return sids.join(', ');
  };
  // 接続点ID: group はタイトルから算出。host は (1)現所属 (2)削除等は props の所属AG (3)CSV取込の接続点ID。
  const settenOf = (e: QamEvent): string =>
    entity === 'group' ? settenId(e.name)
      : (agSetten[e.id] || settenFromProps(e) || propVal(e, '接続点ID'));
  // 「追加された/削除された 値」列。優先: modified の項目別差分(set=added/removed・scalar=new/old)。
  // 無ければ props から（追加/変更→追加側、削除→削除側）。CSV取込も props を入れるので各列に出る。
  const addedOf = (e: QamEvent, scalarF: string | null, setF: string | null): string => {
    if (setF && e.field === setF && e.added?.length) return e.added.join(', ');
    if (scalarF && e.field === scalarF && e.new) return e.new;
    if (e.change === 'added' || e.change === 'modified') return propVal(e, (setF ?? scalarF)!);
    return '';
  };
  const removedOf = (e: QamEvent, scalarF: string | null, setF: string | null): string => {
    if (setF && e.field === setF && e.removed?.length) return e.removed.join(', ');
    if (scalarF && e.field === scalarF && e.old) return e.old;
    if (e.change === 'deleted') return propVal(e, (setF ?? scalarF)!);
    return '';
  };
  const mkChg = (id: string, label: string, fn: (e: QamEvent) => string, mono = false): Column =>
    ({ id, label, mono, render: (e: QamEvent) => esc(fn(e)), sortVal: fn });
  const tsCol: Column = { id: 'ts', label: '更新日', mono: true, render: (e: QamEvent) => esc(fmtStamp(e.ts)), sortVal: (e: QamEvent) => e.ts };
  const changeCol: Column = { id: 'change', label: '変更種別', render: (e: QamEvent) => changeTag(e.change), sortVal: (e: QamEvent) => CHANGE_LABEL[e.change] ?? e.change };
  const idCol: Column = { id: 'id', label: HIST_ID_LABEL[entity], mono: true, render: (e: QamEvent) => esc(e.id), sortVal: (e: QamEvent) => e.id };
  const nameCol: Column = { id: 'name', label: HIST_NAME_LABEL[entity], render: (e: QamEvent) => esc(e.name) };
  const settenCol: Column = { id: 'setten', label: '接続点ID', mono: true, render: (e: QamEvent) => esc(settenOf(e)), sortVal: settenOf };
  const fieldCol: Column = { id: 'field', label: '変更項目', render: (e: QamEvent) => esc(e.field ? fieldLabel(entity, e.field) : ''), sortVal: (e: QamEvent) => (e.field ? fieldLabel(entity, e.field) : '') };
  const oldCol: Column = { id: 'old', label: '変更前/削除', render: oldCell, sortable: false };
  const newCol: Column = { id: 'new', label: '変更後/追加', render: newCell, sortable: false };
  const memoCol: Column = { id: '_c', label: 'メモ', sortable: false, render: (e: QamEvent) => commentCell(e.entity, e.id, comments), sortVal: (e: QamEvent) => latestText(comments, e.id) };

  // 追加/削除された値の専用列（種別ごと）。並びは「追加…→削除…」。
  const extra: Column[] = entity === 'group'
    ? [mkChg('add_ip', '追加IP', (e) => addedOf(e, null, 'IPS'), true), mkChg('add_dns', '追加DNS', (e) => addedOf(e, null, 'DNS_LIST')),
       mkChg('rem_ip', '削除IP', (e) => removedOf(e, null, 'IPS'), true), mkChg('rem_dns', '削除DNS', (e) => removedOf(e, null, 'DNS_LIST'))]
    : entity === 'host'
      ? [mkChg('add_ip', '追加IP', (e) => addedOf(e, 'IP', null), true), mkChg('add_fqdn', '追加FQDN', (e) => addedOf(e, 'FQDN', null)),
         mkChg('rem_ip', '削除IP', (e) => removedOf(e, 'IP', null), true), mkChg('rem_fqdn', '削除FQDN', (e) => removedOf(e, 'FQDN', null))]
      : entity === 'domain'
        ? [mkChg('add_ip', '追加IP', (e) => addedOf(e, null, 'NETBLOCK'), true), mkChg('rem_ip', '削除IP', (e) => removedOf(e, null, 'NETBLOCK'), true)]
        : [];

  // 列構成（entityごと・既定表示順）。既定で隠す列（HISTORY_DEFAULT_HIDDEN）は末尾。
  //  - group: 更新日 接続点ID タイトル 変更種別 変更項目 追加IP 追加DNS 削除IP 削除DNS 変更前 変更後 メモ ／ ID は非表示
  //  - host : 更新日 接続点ID 変更種別 変更項目 追加IP 追加FQDN 削除IP 削除FQDN 変更前 変更後 メモ ／ ID は非表示
  //  - domain: 更新日 ドメイン名 変更種別 変更項目 追加IP 削除IP メモ ／ 変更前・変更後 は非表示
  //  - user : 更新日 変更種別 ユーザID 氏名 変更項目 変更前 変更後 メモ
  if (entity === 'group') return [tsCol, settenCol, nameCol, changeCol, fieldCol, ...extra, oldCol, newCol, memoCol, idCol];
  if (entity === 'host') return [tsCol, settenCol, changeCol, fieldCol, ...extra, oldCol, newCol, memoCol, idCol];
  if (entity === 'domain') return [tsCol, idCol, changeCol, fieldCol, ...extra, memoCol, oldCol, newCol];
  return [tsCol, changeCol, idCol, nameCol, fieldCol, oldCol, newCol, memoCol];
}

// 既定で隠す列（変更履歴）。ユーザーは「列表示」でいつでも表示できる。
export const HISTORY_DEFAULT_HIDDEN: Record<QamEntity, string[]> = {
  group: ['id'], host: ['id'], domain: ['old', 'new'], user: [],
};
