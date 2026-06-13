// 資産一覧 / 変更履歴 の列定義（共通テーブル §25 用）。
import { el, esc } from './dom';
import { icon } from '../icons';
import type { Column } from './table';
import type { QamEntity, QamEvent, QamRecord } from '../types';

const CHANGE_LABEL: Record<string, string> = { added: '追加', modified: '変更', deleted: '削除' };
export const changeTag = (c: string): string => `<span class="qam-tag qam-tag--${c}">${CHANGE_LABEL[c] ?? c}</span>`;

const joined = (a?: string[]): string => esc((a ?? []).join(', '));

// コメントセル: アイコン＋件数。クリックでその資産の作業履歴スレッドを開く。
function commentCell(entity: QamEntity, id: string, count: number, open: (e: QamEntity, id: string) => void): HTMLElement {
  const span = el('span', { class: 'qam-cell-comment', html: `${icon('message', 14)}<span>${count || ''}</span>` });
  span.addEventListener('click', (e) => { e.stopPropagation(); open(entity, id); });
  return span;
}

export function assetColumns(entity: QamEntity, counts: Record<string, number>, openThread: (e: QamEntity, id: string) => void): Column[] {
  const c = (id: string, label: string, render: (r: QamRecord) => string | Node, mono?: boolean): Column => ({ id, label, mono, render, sortVal: (r) => String((render(r) as any)).toString() });
  const sc = (f: string) => (r: QamRecord) => esc(r.scalar[f] ?? '');
  const stc = (f: string) => (r: QamRecord) => joined(r.set[f]);
  const comment: Column = { id: '_c', label: '', sortable: false, render: (r: QamRecord) => commentCell(entity, r.key, counts[r.key] ?? 0, openThread) };
  if (entity === 'group') return [
    c('key', 'ID', (r) => esc(r.key), true), c('name', 'タイトル', (r) => esc(r.name)),
    c('OWNER_ID', 'オーナーID', sc('OWNER_ID'), true), c('IPS', 'IP', stc('IPS')),
    c('DNS_LIST', 'DNS', stc('DNS_LIST')), c('DOMAIN_LIST', 'ドメイン', stc('DOMAIN_LIST')),
    c('LAST_UPDATE', '最終更新', (r) => esc(r.info.LAST_UPDATE ?? ''), true), comment,
  ];
  if (entity === 'host') return [
    c('key', 'ID', (r) => esc(r.key), true), c('name', 'FQDN', (r) => esc(r.name)),
    c('IP', 'IP', sc('IP'), true), c('OS', 'OS', sc('OS')),
    c('TRACKING_METHOD', '追跡', sc('TRACKING_METHOD')), c('NETBIOS', 'NetBIOS', sc('NETBIOS')),
    c('LAST_VULN_SCAN_DATETIME', '最終スキャン', (r) => esc(r.info.LAST_VULN_SCAN_DATETIME ?? ''), true), comment,
  ];
  return [
    c('key', 'ドメイン', (r) => esc(r.key)), c('NETWORK_NAME', 'ネットワーク', sc('NETWORK_NAME')),
    c('NETBLOCK', 'ネットブロック', stc('NETBLOCK')), comment,
  ];
}

export function historyColumns(counts: Record<string, number>, openThread: (e: QamEntity, id: string) => void): Column[] {
  const oldCell = (e: QamEvent): string => e.removed?.length ? `<span class="qam-rem">− ${joined(e.removed)}</span>` : esc(e.old ?? '');
  const newCell = (e: QamEvent): string => e.added?.length ? `<span class="qam-add">+ ${joined(e.added)}</span>` : esc(e.new ?? '');
  return [
    { id: 'ts', label: '日付', mono: true, render: (e: QamEvent) => esc(e.ts), sortVal: (e: QamEvent) => e.ts },
    { id: 'change', label: '種別', render: (e: QamEvent) => changeTag(e.change), sortVal: (e: QamEvent) => e.change },
    { id: 'id', label: 'ID', mono: true, render: (e: QamEvent) => esc(e.id), sortVal: (e: QamEvent) => e.id },
    { id: 'name', label: '名前', render: (e: QamEvent) => esc(e.name) },
    { id: 'field', label: '項目', render: (e: QamEvent) => esc(e.field ?? ''), sortVal: (e: QamEvent) => e.field ?? '' },
    { id: 'old', label: '変更前/削除', render: oldCell, sortable: false },
    { id: 'new', label: '変更後/追加', render: newCell, sortable: false },
    { id: '_c', label: '', sortable: false, render: (e: QamEvent) => commentCell(e.entity, e.id, counts[e.id] ?? 0, openThread) },
  ];
}
