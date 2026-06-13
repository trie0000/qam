// QAM エントリ: レイアウト・状態・ビュー・取込/設定/コメント。
import css from './styles/app.css';
import { BUILD, ENTITIES, LS, fmtStamp, timeOfStamp, datetimeToStamp } from './config';
import { el, esc, clear, onEnter } from './ui/dom';
import { icon } from './icons';
import { toast } from './ui/toast';
import { openModal } from './ui/modal';
import { renderTable } from './ui/table';
import { renderCalendar } from './ui/calendar';
import { assetColumns, historyColumns } from './ui/columns';
import { backend, getConfig, setConfig, shutdownRelay, qualysLogin, qualysLogout } from './relay';
import { downloadEntity } from './qualys';
import { parseQualysXml } from './ingest/parse';
import {
  getSnapshotStamps, resolveAsof, readSnapshot, readHistory, readComments, addComment, ingestSnapshot, deleteSnapshot, dateOfStamp,
} from './store';
import type { QamComment, QamEntity, QamEvent, QamRecord } from './types';

const GUARD_RATIO = 0.5;

const state = {
  mode: 'assets' as 'assets' | 'history',
  entity: 'group' as QamEntity,
  asof: '',
  q: '',
  histDate: '',
  histStamp: '',
  change: new Set(['added', 'modified', 'deleted']),
  selected: new Set<string>(),
  wrap: false,
};

// IPv4 を整数へ（不正なら null）。レンジ内判定に使う。
function ipToInt(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return p[0] * 2 ** 24 + p[1] * 2 ** 16 + p[2] * 2 ** 8 + p[3];
}
function ipInRange(ipInt: number, range: string): boolean {
  const i = range.indexOf('-');
  if (i < 0) return false;
  const a = ipToInt(range.slice(0, i)); const b = ipToInt(range.slice(i + 1));
  return a !== null && b !== null && ipInt >= a && ipInt <= b;
}
// 資産の検索: 文字列部分一致 ＋ クエリが IPv4 なら set 内のレンジ(a-b)に含まれるかも判定。
function matchAsset(r: QamRecord, q: string): boolean {
  if (!q) return true;
  const lq = q.toLowerCase();
  const texts = [r.key, r.name, ...Object.values(r.scalar), ...Object.values(r.set).flat()];
  if (texts.some((t) => String(t ?? '').toLowerCase().includes(lq))) return true;
  const qi = ipToInt(q);
  if (qi !== null) {
    for (const arr of Object.values(r.set)) {
      for (const v of arr) if (typeof v === 'string' && v.includes('-') && ipInRange(qi, v)) return true;
    }
  }
  return false;
}

// ---- shell ----
const style = document.createElement('style'); style.textContent = css; document.head.append(style);
document.documentElement.dataset.theme = localStorage.getItem(LS.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const root = document.getElementById('qam-root')!;
const main = el('div', { class: 'qam-main' });
const left = el('div', { class: 'qam-left' });
const topbar = el('div', { class: 'qam-topbar' });
root.append(el('div', { class: 'qam-app' }, [topbar, el('div', { class: 'qam-body' }, [left, main])]));

function iconBtn(name: string, label: string, on: () => void | Promise<void>): HTMLElement {
  const b = el('button', { class: 'btn btn--icon', 'aria-label': label, title: label, html: icon(name, 18) });
  // async ハンドラの失敗を握り潰さない（無反応の正体）。失敗はトーストで出す。
  b.addEventListener('click', () => { Promise.resolve().then(on).catch((e) => toast(`${label}でエラー: ${(e as Error).message}`, 'error')); });
  return b;
}
const ingestBtn = el('button', { class: 'btn btn--sm', html: `${icon('upload', 16)}<span>取込</span>` });
ingestBtn.addEventListener('click', () => { try { openIngest(); } catch (e) { toast(`取込でエラー: ${(e as Error).message}`, 'error'); } });
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
  left.append(leftCalHost); // 変更履歴モードでカレンダーをここに描画
}
const leftCalHost = el('div', { class: 'qam-cal-host' });

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
  // 全文表示トグル（列幅で折り返して全文表示）
  const wrapBtn = el('button', { class: state.wrap ? 'btn btn--sm btn--primary' : 'btn btn--sm', title: '列幅で折り返して全文表示' }, ['全文表示']);
  wrapBtn.addEventListener('click', () => {
    state.wrap = !state.wrap;
    wrapBtn.className = state.wrap ? 'btn btn--sm btn--primary' : 'btn btn--sm';
    main.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
  });
  toolbar.append(wrapBtn);

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
  clear(leftCalHost); // 資産一覧モードではカレンダー非表示
  const stamps = await getSnapshotStamps(backend, state.entity);
  // as-of セレクタ（取込日時）
  const sel = el('select', { class: 'in' }) as HTMLSelectElement;
  sel.append(el('option', { value: '' }, ['最新']));
  for (const s of [...stamps].reverse()) sel.append(el('option', { value: s, selected: state.asof === s }, [fmtStamp(s)]));
  sel.addEventListener('change', () => { state.asof = sel.value; refresh(); });
  subbar.append(el('span', { class: 'qam-count' }, ['基準（取込日時）']), sel);

  const stamp = resolveAsof(stamps, state.asof || undefined);
  clear(host);
  if (!stamp) {
    host.append(emptyState(stamps.length ? '保存期間外です' : 'まだ取り込みがありません', stamps.length ? '変更履歴ビューで確認するか、別の取込日時を選んでください' : '右上の「取込」から Qualys を取り込んでください'));
    count.textContent = '0 件'; return;
  }
  // 表示中の取込(基準)を削除するボタン（前後の取込は残る）
  const delBtn = el('button', { class: 'btn btn--sm btn--danger', title: '表示中の取込日時のスナップショットを削除' }, ['この取込を削除']);
  delBtn.addEventListener('click', async () => {
    if (!(await confirmModal('スナップショット削除', `${state.entity} の ${fmtStamp(stamp)} のスナップショット（とこの取込の履歴）を削除します。よろしいですか？`))) return;
    try { await deleteSnapshot(backend, state.entity, stamp); state.asof = ''; toast('削除しました', 'ok'); refresh(); }
    catch (e) { toast('削除に失敗: ' + (e as Error).message, 'error'); }
  });
  subbar.append(delBtn);

  const snap = await readSnapshot(backend, state.entity, stamp);
  let rows = Object.values(snap?.records ?? {}) as QamRecord[];
  rows = rows.filter((r) => matchAsset(r, state.q));
  count.textContent = `${rows.length} 件 / ${fmtStamp(stamp)} 時点`;
  const counts = await commentCounts(state.entity);
  clear(host);
  host.append(renderTable({
    viewId: `assets.${state.entity}`, columns: assetColumns(state.entity, counts, openThread),
    rows, getKey: (r) => r.key, selected: state.selected, bulkActions: bulkComment,
  }));
  host.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
}

async function renderHistory(subbar: HTMLElement, count: HTMLElement, toolbar: HTMLElement, host: HTMLElement): Promise<void> {
  const all = await readHistory(backend, state.entity);
  const stamps = await getSnapshotStamps(backend, state.entity);

  // 左ペイン: 変更があった日に印を付けたカレンダー
  const markedDays = new Set(all.map((e) => dateOfStamp(e.ts)));
  clear(leftCalHost);
  leftCalHost.append(el('div', { class: 'qam-navhead' }, ['変更カレンダー']));
  leftCalHost.append(renderCalendar({
    marked: markedDays, selected: state.histDate,
    onSelect: (d) => { state.histDate = d; state.histStamp = ''; refresh(); },
  }));

  // toolbar: 時刻(取込日時)ドロップダウン — 選択日の取込時刻だけを出す
  if (state.histDate) {
    const tsel = el('select', { class: 'in' }) as HTMLSelectElement;
    tsel.append(el('option', { value: '' }, ['終日（全取込）']));
    for (const s of stamps.filter((s) => dateOfStamp(s) === state.histDate)) {
      tsel.append(el('option', { value: s, selected: state.histStamp === s }, [timeOfStamp(s)]));
    }
    tsel.addEventListener('change', () => { state.histStamp = tsel.value; refresh(); });
    toolbar.append(el('span', { class: 'qam-count' }, [`${state.histDate} の時刻`]), tsel);
  }
  for (const ch of ['added', 'modified', 'deleted']) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = state.change.has(ch);
    cb.addEventListener('change', () => { cb.checked ? state.change.add(ch) : state.change.delete(ch); refresh(); });
    const lab = el('label', { class: 'qam-chip', style: 'display:inline-flex;gap:4px;align-items:center;font-size:var(--fs-sm)' }, [cb, ({ added: '追加', modified: '変更', deleted: '削除' } as any)[ch]]);
    toolbar.append(lab);
  }

  let events = all.filter((e) =>
    state.change.has(e.change)
    && (!state.histDate || dateOfStamp(e.ts) === state.histDate)
    && (!state.histStamp || e.ts === state.histStamp)
    && matchQ([e.id, e.name, e.field, e.old, e.new, ...(e.added ?? []), ...(e.removed ?? [])]));
  events.reverse(); // 新しい順を既定に
  count.textContent = `${events.length} 件${state.histDate ? ` / ${state.histDate}${state.histStamp ? ' ' + timeOfStamp(state.histStamp) : ''}` : ''}`;
  const counts = await commentCounts(state.entity);
  clear(host);
  host.append(renderTable({
    viewId: `history.${state.entity}`, columns: historyColumns(counts, openThread),
    rows: events, getKey: (e: QamEvent) => e.eid, selected: state.selected,
  }));
  host.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
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
  // 取込日時 = XML の DATETIME 由来。重複チェック: 同 stamp=上書き確認 / 同日=追加確認。
  const stamp = datetimeToStamp(snap.datetime);
  const existing = await getSnapshotStamps(backend, snap.entity);
  if (existing.includes(stamp)) {
    if (!(await confirmModal('既に取込済み（同じ取込日時）', `${snap.entity} の ${fmtStamp(stamp)} は既に取り込まれています。上書きしますか？`))) {
      toast(`${snap.entity}: 取込を中止しました`, 'info'); return;
    }
  } else if (existing.some((s) => dateOfStamp(s) === dateOfStamp(stamp))) {
    if (!(await confirmModal('同じ日に取込済み', `${snap.entity} は ${dateOfStamp(stamp)} に取込済みです。別の取込として追加しますか？（前のスナップショットは残ります）`))) {
      toast(`${snap.entity}: 取込を中止しました`, 'info'); return;
    }
  }
  const opts = { stamp, guardRatio: GUARD_RATIO, retentionDays: cfg.retentionDays || 90, rawXml: raw };
  let res = await ingestSnapshot(backend, snap as any, opts);
  if (res.guard && !res.committed) {
    const ok = await confirmModal('件数が大きく減少しています', `${snap.entity}: ${res.prevCount} → ${res.currCount} 件。誤ったファイルでないか確認してください。取り込みますか？`);
    if (!ok) { toast(`${snap.entity}: 取り込みを中止しました`, 'info'); return; }
    res = await ingestSnapshot(backend, snap as any, { ...opts, force: true });
  }
  const sum = res.baseline ? '初回取込・基準確立' : `+${res.added}/~${res.modified}/-${res.deleted}`;
  toast(`${snap.entity} ${fmtStamp(res.stamp)}: ${res.currCount.toLocaleString()}件 (${sum})`, res.currCount === 0 ? 'info' : 'ok');
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
        // session login は「できれば」。失敗しても止めず、従来どおり Basic 認証で続行する
        // （login 必須化で動かなくなった反省）。relay は session があれば Cookie、無ければ Basic を使う。
        setProg('Qualys にログイン中…', true);
        let useSession = false;
        try {
          const lg = await qualysLogin(creds);
          useSession = !!lg.ok;
          if (!useSession) toast('セッションログイン不可のため Basic 認証で続行します' + (lg.error ? `（${lg.error}）` : ''), 'info');
        } catch { useSession = false; }
        try {
          for (const k of kinds) {
            setProg(`${labelOf(k)}: ダウンロード中…`, true);
            const dl = await downloadEntity(k, creds, (p) => setProg(`${labelOf(k)}: ${p.page} ページ目・${p.records.toLocaleString()} 件取得…`, true));
            setProg(`${labelOf(k)}: 差分計算・保存中…（${Object.keys(dl.snapshot.records).length.toLocaleString()} 件）`, true);
            await commitOne(dl.snapshot, dl.raw);
          }
        } finally {
          if (useSession) { setProg('Qualys からログアウト中…', true); await qualysLogout().catch(() => undefined); }
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
