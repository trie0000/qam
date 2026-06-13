// QAM エントリ: レイアウト・状態・ビュー・取込/設定/コメント。
import css from './styles/app.css';
import { BUILD, ENTITIES, LS, today } from './config';
import { el, esc, clear, onEnter } from './ui/dom';
import { icon } from './icons';
import { toast } from './ui/toast';
import { openModal } from './ui/modal';
import { renderTable } from './ui/table';
import { assetColumns, historyColumns } from './ui/columns';
import { backend, getConfig, setConfig, shutdownRelay, qualysLogin, qualysLogout } from './relay';
import { downloadEntity } from './qualys';
import { parseQualysXml } from './ingest/parse';
import {
  getSnapshotDates, resolveAsof, readSnapshot, readHistory, readComments, addComment, ingestSnapshot,
} from './store';
import type { QamComment, QamEntity, QamEvent, QamRecord } from './types';

const GUARD_RATIO = 0.5;

const state = {
  mode: 'assets' as 'assets' | 'history',
  entity: 'group' as QamEntity,
  asof: '',
  q: '',
  from: '',
  to: '',
  change: new Set(['added', 'modified', 'deleted']),
  selected: new Set<string>(),
};

// ---- shell ----
const style = document.createElement('style'); style.textContent = css; document.head.append(style);
document.documentElement.dataset.theme = localStorage.getItem(LS.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const root = document.getElementById('qam-root')!;
const main = el('div', { class: 'qam-main' });
const left = el('div', { class: 'qam-left' });
const topbar = el('div', { class: 'qam-topbar' });
root.append(el('div', { class: 'qam-app' }, [topbar, el('div', { class: 'qam-body' }, [left, main])]));

function iconBtn(name: string, label: string, on: () => void): HTMLElement {
  const b = el('button', { class: 'btn btn--icon', 'aria-label': label, title: label, html: icon(name, 18) });
  b.addEventListener('click', on); return b;
}
const ingestBtn = el('button', { class: 'btn btn--sm', html: `${icon('upload', 16)}<span>取込</span>` });
ingestBtn.addEventListener('click', openIngest);
topbar.append(
  el('div', { class: 'qam-brandwrap' }, [
    el('span', { class: 'qam-badge' }, ['N']),
    el('span', { class: 'qam-brand' }, ['QAM']),
    el('span', { class: 'qam-subtitle' }, ['Qualys Asset Management']),
  ]),
  el('span', { class: 'qam-build' }, [`build ${BUILD}`]),
  ingestBtn,
  iconBtn('refresh', '更新', refresh),
  iconBtn('settings', '設定', openSettings),
  iconBtn('logout', '終了', doShutdown),
);

function renderLeft(): void {
  clear(left);
  left.append(el('div', { class: 'qam-navhead' }, ['ビュー']));
  const nav = el('div', { class: 'qam-nav' });
  const modes: [typeof state.mode, string][] = [['assets', '資産一覧'], ['history', '変更履歴']];
  for (const [m, label] of modes) {
    const b = el('button', { 'aria-current': String(state.mode === m), html: `${icon(m === 'assets' ? 'file' : 'refresh', 16)}<span>${label}</span>` });
    b.addEventListener('click', () => { state.mode = m; state.selected.clear(); refresh(); });
    nav.append(b);
  }
  left.append(nav);
}

// ---- main render ----
async function refresh(): Promise<void> {
  renderLeft();
  clear(main);
  // tabs
  const tabs = el('div', { class: 'qam-tabs' });
  for (const e of ENTITIES) {
    const t = el('button', { class: 'qam-tab', 'aria-current': String(state.entity === e.key) }, [e.label]);
    t.addEventListener('click', () => { state.entity = e.key; state.selected.clear(); refresh(); });
    tabs.append(t);
  }
  // subbar
  const subbar = el('div', { class: 'qam-subbar' });
  const title = el('span', { class: 'qam-title' }, [state.mode === 'assets' ? '資産一覧' : '変更履歴']);
  const count = el('span', { class: 'qam-count' });
  subbar.append(title, count, el('span', { class: 'qam-spacer' }));
  // toolbar
  const toolbar = el('div', { class: 'qam-toolbar' });
  const search = el('div', { class: 'qam-search', html: icon('search', 14) });
  const sIn = el('input', { type: 'text', placeholder: '検索（ID / 名前 / IP / FQDN）', value: state.q }) as HTMLInputElement;
  onEnter(sIn, () => { state.q = sIn.value.trim(); refresh(); });
  sIn.addEventListener('change', () => { state.q = sIn.value.trim(); refresh(); });
  search.append(sIn); toolbar.append(search);

  const tableHost = el('div', { style: 'min-height:0;overflow:hidden' });
  tableHost.append(el('div', { class: 'qam-tablewrap' }, [skeleton()]));
  main.append(tabs, subbar, toolbar, tableHost);

  if (state.mode === 'assets') await renderAssets(subbar, count, tableHost);
  else await renderHistory(subbar, count, toolbar, tableHost);
}

const skeleton = (): HTMLElement => el('div', {}, Array.from({ length: 6 }, () => el('div', { class: 'qam-skeleton' })));

function matchQ(parts: (string | undefined)[]): boolean {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return parts.some((p) => (p ?? '').toLowerCase().includes(q));
}

async function commentCounts(entity: QamEntity): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  for (const c of await readComments(backend, entity)) map[c.id] = (map[c.id] ?? 0) + 1;
  return map;
}

async function renderAssets(subbar: HTMLElement, count: HTMLElement, host: HTMLElement): Promise<void> {
  const dates = await getSnapshotDates(backend, state.entity);
  // as-of セレクタ
  const sel = el('select', { class: 'in' }) as HTMLSelectElement;
  sel.append(el('option', { value: '' }, ['最新']));
  for (const d of [...dates].reverse()) sel.append(el('option', { value: d, selected: state.asof === d }, [d]));
  sel.addEventListener('change', () => { state.asof = sel.value; refresh(); });
  subbar.append(el('span', { class: 'qam-count' }, ['基準日']), sel);

  const date = resolveAsof(dates, state.asof || undefined);
  clear(host);
  if (!date) {
    host.append(emptyState(dates.length ? '保存期間外の日付です' : 'まだ取り込みがありません', dates.length ? '変更履歴ビューで確認するか、別の基準日を選んでください' : '右上の「取込」から Qualys を取り込んでください'));
    count.textContent = '0 件'; return;
  }
  const snap = await readSnapshot(backend, state.entity, date);
  let rows = Object.values(snap?.records ?? {}) as QamRecord[];
  rows = rows.filter((r) => matchQ([r.key, r.name, r.scalar.IP, r.scalar.FQDN, ...Object.values(r.set).flat()]));
  count.textContent = `${rows.length} 件 / ${date} 時点`;
  const counts = await commentCounts(state.entity);
  clear(host);
  host.append(renderTable({
    viewId: `assets.${state.entity}`, columns: assetColumns(state.entity, counts, openThread),
    rows, getKey: (r) => r.key, selected: state.selected, bulkActions: bulkComment,
  }));
}

async function renderHistory(subbar: HTMLElement, count: HTMLElement, toolbar: HTMLElement, host: HTMLElement): Promise<void> {
  // 期間 + 種別フィルタ
  const from = el('input', { type: 'date', class: 'in', value: state.from }) as HTMLInputElement;
  const to = el('input', { type: 'date', class: 'in', value: state.to }) as HTMLInputElement;
  from.addEventListener('change', () => { state.from = from.value; refresh(); });
  to.addEventListener('change', () => { state.to = to.value; refresh(); });
  toolbar.append(el('span', { class: 'qam-count' }, ['期間']), from, el('span', {}, ['〜']), to);
  for (const ch of ['added', 'modified', 'deleted']) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = state.change.has(ch);
    cb.addEventListener('change', () => { cb.checked ? state.change.add(ch) : state.change.delete(ch); refresh(); });
    const lab = el('label', { class: 'qam-chip', style: 'display:inline-flex;gap:4px;align-items:center;font-size:var(--fs-sm)' }, [cb, ({ added: '追加', modified: '変更', deleted: '削除' } as any)[ch]]);
    toolbar.append(lab);
  }

  let events = await readHistory(backend, state.entity, state.from || undefined, state.to || undefined);
  events = events.filter((e) => state.change.has(e.change) && matchQ([e.id, e.name, e.field, e.old, e.new, ...(e.added ?? []), ...(e.removed ?? [])]));
  events.reverse(); // 新しい順を既定に
  count.textContent = `${events.length} 件`;
  const counts = await commentCounts(state.entity);
  clear(host);
  host.append(renderTable({
    viewId: `history.${state.entity}`, columns: historyColumns(counts, openThread),
    rows: events, getKey: (e: QamEvent) => e.eid, selected: state.selected,
  }));
}

const emptyState = (t: string, d: string): HTMLElement => el('div', { class: 'qam-empty' }, [el('div', { class: 'qam-empty-title' }, [t]), el('div', {}, [d])]);

function bulkComment(keys: string[]): HTMLElement[] {
  const b = el('button', { class: 'btn btn--sm', html: `${icon('message', 14)}<span>選択にコメント</span>` });
  b.addEventListener('click', () => openThread(state.entity, keys[0]));
  return keys.length === 1 ? [b] : [];
}

// ---- comment thread ----
async function openThread(entity: QamEntity, id: string): Promise<void> {
  const list = el('div', { class: 'qam-thread' });
  const ta = el('textarea', { placeholder: '改廃作業のメモ（Ctrl/⌘+Enter で投稿）' }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn--icon btn--primary qam-note-submit', 'aria-label': '投稿', html: icon('send', 16) });
  const form = el('div', { class: 'qam-note-form' }, [ta, send]);
  const body = el('div', {}, [el('div', { class: 'qam-field' }, [el('label', {}, [`${entity} / ${id} の作業履歴`])]), list, form]);

  async function reload(): Promise<void> {
    clear(list);
    const comments = await readComments(backend, entity, id);
    if (!comments.length) list.append(el('div', { class: 'qam-count' }, ['まだコメントはありません']));
    for (const c of comments) list.append(el('div', { class: 'qam-comment' }, [
      el('div', { class: 'qam-meta' }, [`${c.ts}${c.author ? ' · ' + c.author : ''}`]),
      el('div', { html: esc(c.text).replace(/\n/g, '<br>') }),
    ]));
  }
  async function submit(): Promise<void> {
    const text = ta.value.trim(); if (!text) return;
    send.setAttribute('disabled', 'true');
    try {
      const c: QamComment = { ts: new Date().toISOString(), entity, id, author: localStorage.getItem('qam.author') || '', text };
      await addComment(backend, c); ta.value = ''; await reload(); toast('コメントを追加しました', 'ok');
    } catch (e) { toast('コメントの追加に失敗しました: ' + (e as Error).message, 'error'); }
    finally { send.removeAttribute('disabled'); }
  }
  send.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => { if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });
  openModal({ title: '作業履歴コメント', body });
  await reload();
}

// ---- ingest ----
async function commitOne(snap: { entity: QamEntity; datetime: string; records: any }, raw?: string): Promise<void> {
  const cfg = await getConfig();
  const opts = { today: today(), guardRatio: GUARD_RATIO, retentionDays: cfg.retentionDays || 90, rawXml: raw };
  let res = await ingestSnapshot(backend, snap as any, opts);
  if (res.guard && !res.committed) {
    const ok = await confirmModal('件数が大きく減少しています', `${snap.entity}: ${res.prevCount} → ${res.currCount} 件。誤ったファイルでないか確認してください。取り込みますか？`);
    if (!ok) { toast(`${snap.entity}: 取り込みを中止しました`, 'info'); return; }
    res = await ingestSnapshot(backend, snap as any, { ...opts, force: true });
  }
  const sum = res.baseline ? '初回取込（基準確立）' : `+${res.added} / ~${res.modified} / -${res.deleted}`;
  toast(`${snap.entity} ${res.date}: ${sum}`, 'ok');
}

function confirmModal(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title, body: el('div', { style: 'user-select:text' }, [message]), primaryLabel: '取り込む',
      onPrimary: () => { done = true; resolve(true); return true; },
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

function openIngest(): void {
  const panel = el('div', {});
  const body = el('div', {});
  const seg = el('div', { class: 'qam-chip-row', style: 'margin-bottom:var(--s-5)' });
  const apiBtn = el('button', { class: 'btn btn--sm' }, ['API ダウンロード']);
  const xmlBtn = el('button', { class: 'btn btn--sm' }, ['XML アップロード']);
  const prog = el('div', { class: 'qam-progress', style: 'display:none' });
  seg.append(apiBtn, xmlBtn); body.append(seg, panel, prog);

  const labelOf = (k: QamEntity): string => ENTITIES.find((e) => e.key === k)?.label ?? k;
  function setProg(msg: string, busy: boolean): void {
    clear(prog); prog.style.display = 'flex';
    prog.append(busy ? el('span', { class: 'qam-spin' }) : el('span', { html: icon('check', 16) }), el('span', { class: 'qam-prog-msg' }, [msg]));
  }

  function showApi(): void {
    apiBtn.className = 'btn btn--sm btn--primary'; xmlBtn.className = 'btn btn--sm';
    clear(panel);
    const sel = el('select', { class: 'in' }) as HTMLSelectElement;
    sel.append(el('option', { value: 'all' }, ['すべて (AssetGroup / Host / Domain)']));
    ENTITIES.forEach((e) => sel.append(el('option', { value: e.key }, [e.label])));
    const go = el('button', { class: 'btn btn--primary', html: `${icon('download', 16)}<span>ダウンロードして取込</span>` });
    go.addEventListener('click', async () => {
      go.setAttribute('disabled', 'true'); sel.setAttribute('disabled', 'true');
      try {
        const cfg = await getConfig();
        const creds = { base: cfg.qualysBase, user: cfg.qualysUser, pass: localStorage.getItem(LS.qualysPass) || '', proxy: cfg.proxy };
        if (!creds.base || !creds.user) { setProg('設定で Qualys 接続先とアカウントを入力してください', false); toast('設定が未入力です', 'error'); return; }
        const kinds = sel.value === 'all' ? ENTITIES.map((e) => e.key) : [sel.value as QamEntity];
        setProg('Qualys にログイン中…', true);
        const lg = await qualysLogin(creds);
        if (!lg.ok) throw new Error('Qualys ログイン失敗' + (lg.error ? ': ' + lg.error : ` (status ${lg.status ?? '?'})`));
        try {
          for (const k of kinds) {
            setProg(`${labelOf(k)}: ダウンロード中…`, true);
            const dl = await downloadEntity(k, creds, (p) => setProg(`${labelOf(k)}: ${p.page} ページ目・${p.records.toLocaleString()} 件取得…`, true));
            setProg(`${labelOf(k)}: 差分計算・保存中…（${Object.keys(dl.snapshot.records).length.toLocaleString()} 件）`, true);
            await commitOne(dl.snapshot, dl.raw);
          }
        } finally {
          setProg('Qualys からログアウト中…', true);
          await qualysLogout().catch(() => undefined);
        }
        setProg('完了しました', false);
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { go.removeAttribute('disabled'); sel.removeAttribute('disabled'); }
    });
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['取得対象']), sel]), go);
  }
  function showXml(): void {
    xmlBtn.className = 'btn btn--sm btn--primary'; apiBtn.className = 'btn btn--sm';
    clear(panel);
    const file = el('input', { type: 'file', accept: '.xml', class: 'in' }) as HTMLInputElement;
    const go = el('button', { class: 'btn btn--primary', html: `${icon('upload', 16)}<span>取込</span>` });
    go.addEventListener('click', async () => {
      if (!file.files?.length) { toast('XML ファイルを選択してください', 'error'); return; }
      go.setAttribute('disabled', 'true');
      try {
        setProg('解析中…', true);
        const text = await file.files[0].text();
        const snap = parseQualysXml(text);
        setProg(`${labelOf(snap.entity)}: 差分計算・保存中…（${Object.keys(snap.records).length.toLocaleString()} 件）`, true);
        await commitOne(snap, text);
        setProg('完了しました', false);
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { go.removeAttribute('disabled'); }
    });
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['Qualys 一覧 XML（種別は自動判定）']), file]), go);
  }
  apiBtn.addEventListener('click', showApi); xmlBtn.addEventListener('click', showXml);
  showApi();
  openModal({ title: '取り込み', body });
}

// ---- settings ----
async function openSettings(): Promise<void> {
  const cfg = await getConfig();
  const field = (label: string, input: HTMLElement) => el('div', { class: 'qam-field' }, [el('label', {}, [label]), input]);
  const base = el('input', { class: 'in', value: cfg.qualysBase || '', placeholder: 'https://YOUR-POD.qualysapi.example.com' }) as HTMLInputElement;
  const user = el('input', { class: 'in', value: cfg.qualysUser || '' }) as HTMLInputElement;
  const pass = el('input', { class: 'in', type: 'password', value: localStorage.getItem(LS.qualysPass) || '' }) as HTMLInputElement;
  const proxy = el('input', { class: 'in', value: cfg.proxy || '', placeholder: 'http://proxy:8080' }) as HTMLInputElement;
  const ret = el('input', { class: 'in', type: 'number', min: '1', value: String(cfg.retentionDays || 90) }) as HTMLInputElement;
  const body = el('div', {}, [
    field('Qualys 接続先 POD', base), field('アカウント', user), field('パスワード（ブラウザに保存）', pass),
    field('プロキシ URL', proxy), field('保存期間（日）', ret),
  ]);
  openModal({
    title: '設定', body, primaryLabel: '保存',
    onPrimary: async () => {
      try {
        await setConfig({ qualysBase: base.value.trim(), qualysUser: user.value.trim(), proxy: proxy.value.trim(), retentionDays: parseInt(ret.value, 10) || 90 });
        if (pass.value) localStorage.setItem(LS.qualysPass, pass.value); else localStorage.removeItem(LS.qualysPass);
        toast('設定を保存しました', 'ok'); return true;
      } catch (e) { toast('保存に失敗しました: ' + (e as Error).message, 'error'); return false; }
    },
  });
}

async function doShutdown(): Promise<void> {
  const ok = await confirmModal('終了', 'QAM を終了します（ローカル中継を停止）。よろしいですか？');
  if (!ok) return;
  try { await shutdownRelay(); } catch { /* listener 停止で接続断は想定内 */ }
  document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#7a766c">QAM を終了しました。このタブは閉じて構いません。</div>';
}

refresh();
