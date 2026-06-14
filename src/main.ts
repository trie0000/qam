// QAM エントリ: レイアウト・状態・ビュー・取込/設定/コメント。
import css from './styles/app.css';
import { BUILD, BUILDTIME, ENTITIES, LS, fmtStamp, datetimeToStamp, stampNow } from './config';
import { el, esc, clear, onEnter } from './ui/dom';
import { icon } from './icons';
import { toast } from './ui/toast';
import { openModal } from './ui/modal';
import { renderTable, cellText, type ExportMatrix, type FilterRef, type Column } from './ui/table';
import { exportCsv, exportXlsx, exportXlsxBook, type Sheet } from './export';
import { renderCalendar } from './ui/calendar';
import { assetColumns, historyColumns, settenId, type CommentApi, type AnnotApi } from './ui/columns';
import { backend, getConfig, setConfig, shutdownRelay, checkRelay } from './relay';
import { downloadEntity } from './qualys';
import { parseQualysXml } from './ingest/parse';
import { parseHistoryCsv, HIST_HEADER_HINT } from './ingest/history-csv';
import {
  getSnapshotStamps, resolveAsof, readSnapshot, readHistory, readComments, addComment, editComment, ingestSnapshot, deleteSnapshot, dateOfStamp, importHistory, readAnnotations, setAnnotation, removeHistoryEvents, logOp, readOps, resetData, type QamOp,
} from './store';
import type { QamComment, QamEntity, QamEvent, QamRecord } from './types';

// 操作履歴記録: 作業者(個人設定の記入者名)＋時刻で登録/削除/変更を残す。失敗しても本処理は止めない。
function recordOp(action: string, detail: string, entity?: QamEntity): void {
  const op: QamOp = { ts: new Date().toISOString(), author: localStorage.getItem(LS.author) || '', action, entity, detail };
  logOp(backend, op).catch(() => undefined);
}

const GUARD_RATIO = 0.5;

const state = {
  mode: 'assets' as 'assets' | 'history' | 'ops',
  entity: 'group' as QamEntity,
  asof: '',
  q: '',
  histFrom: '',
  histTo: '',
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
document.documentElement.dataset.fontsize = localStorage.getItem(LS.fontsize) || 'md'; // 文字サイズ 大中小

// 注意書きのコールアウト（小さめ・左アクセント線）。
function callout(text: string): HTMLElement {
  return el('div', { class: 'qam-callout' }, [el('span', { html: icon('alert', 13) }), el('span', {}, [text])]);
}

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
const ingestBtn = el('button', { class: 'btn btn--sm', html: `${icon('inbox', 16)}<span>取込</span>` });
ingestBtn.addEventListener('click', () => { try { openIngest(); } catch (e) { toast(`取込でエラー: ${(e as Error).message}`, 'error'); } });
const exportAllBtn = el('button', { class: 'btn btn--sm', title: '全種別の最新スナップショットを1つのExcelに出力（種別ごとにシート分け）', html: `${icon('download', 16)}<span>全資産Excel</span>` });
exportAllBtn.addEventListener('click', () => { Promise.resolve().then(exportAllAssets).catch((e) => toast(`全資産Excel出力でエラー: ${(e as Error).message}`, 'error')); });
topbar.append(
  el('div', { class: 'qam-brandwrap' }, [
    el('span', { class: 'qam-badge' }, ['N']),
    el('span', { class: 'qam-brand' }, ['QAM']),
    el('span', { class: 'qam-subtitle' }, ['Qualys Asset Management']),
  ]),
  el('span', { class: 'qam-build', title: BUILDTIME ? `ビルド日時: ${BUILDTIME}` : '' }, [`build ${BUILD}${BUILDTIME ? ` (${BUILDTIME})` : ''}`]),
  ingestBtn,
  exportAllBtn,
  iconBtn('refresh', '更新', refresh),
  iconBtn('settings', '設定', openSettings),
  iconBtn('logout', '終了', doShutdown),
);

function renderLeft(): void {
  clear(left);
  left.append(el('div', { class: 'qam-navhead' }, ['ビュー']));
  const nav = el('div', { class: 'qam-nav' });
  const modes: [typeof state.mode, string, string][] = [['assets', '資産一覧', 'file'], ['history', '変更履歴', 'refresh'], ['ops', '操作履歴', 'message']];
  for (const [m, label, ic] of modes) {
    const b = el('button', { 'aria-current': String(state.mode === m), html: `${icon(ic, 16)}<span>${label}</span>` });
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
  // tabs（操作履歴は全種別共通なので種別タブは出さない。行数維持のため空のタブ行は残す）
  const tabs = el('div', { class: 'qam-tabs' });
  if (state.mode !== 'ops') for (const e of ENTITIES) {
    const t = el('button', { class: 'qam-tab', 'aria-current': String(state.entity === e.key) }, [e.label]);
    t.addEventListener('click', () => { state.entity = e.key; state.selected.clear(); refresh(); });
    tabs.append(t);
  }
  // subbar
  const subbar = el('div', { class: 'qam-subbar' });
  const title = el('span', { class: 'qam-title' }, [state.mode === 'assets' ? '資産一覧' : state.mode === 'history' ? '変更履歴' : '操作履歴']);
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

  const filterBar = el('div', { class: 'qam-filterbar' });
  const tableHost = el('div', { style: 'min-height:0;overflow:hidden' });
  tableHost.append(el('div', { class: 'qam-tablewrap' }, [skeleton()]));
  main.append(tabs, subbar, toolbar, filterBar, tableHost);

  if (state.mode === 'assets') await renderAssets(subbar, count, toolbar, filterBar, tableHost);
  else if (state.mode === 'history') await renderHistory(subbar, count, toolbar, filterBar, tableHost);
  else await renderOps(subbar, count, toolbar, filterBar, tableHost);
}

const skeleton = (): HTMLElement => el('div', {}, Array.from({ length: 6 }, () => el('div', { class: 'qam-skeleton' })));

function matchQ(parts: (string | undefined)[]): boolean {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return parts.some((p) => (p ?? '').toLowerCase().includes(q));
}

// コメント列に渡すAPI。byId は id→コメント(ts昇順)。save は ts指定で編集/null で新規追加。
// フィルタUI（memola風）: 「フィルター」ボタン→列ピッカーのポップオーバー→チップ（ラベル+値入力+×）。
// 複数チップは AND、各チップ内はカンマで OR。状態はテーブル側(localStorage/ビュー単位)が保持する。
function fltIcon(c: { id: string; mono?: boolean }): string {
  if (/DATE|UPDATE|SCAN|LOGIN|^ts$/i.test(c.id)) return '📅';
  return c.mono ? '#' : 'Aa';
}
function addFilterUI(toolbar: HTMLElement, filterBar: HTMLElement, fr: FilterRef): void {
  document.getElementById('qam-flt-pop')?.remove(); // 再描画時に前回のポップオーバーが残らないように
  const pop = el('div', { class: 'qam-flt-pop', id: 'qam-flt-pop' });
  document.body.append(pop);
  const chips = el('div', { class: 'qam-flt-chips' });
  filterBar.append(chips);

  const btn = el('button', { class: 'btn btn--sm', html: `${icon('chevronDown', 14)}<span>フィルター</span>` });

  function renderChips(): void {
    clear(chips);
    for (const c of fr.list()) {
      const chip = el('div', { class: 'qam-flt-chip' });
      chip.append(el('span', { class: 'qam-flt-chip-label' }, [c.label]));
      const inp = el('input', { type: 'text', class: 'qam-flt-chip-val', placeholder: '値…(,でOR)', value: c.value }) as HTMLInputElement;
      inp.addEventListener('input', () => fr.setValue(c.id, inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') inp.blur(); });
      const x = el('button', { class: 'qam-flt-chip-x', title: '削除', html: icon('x', 12) });
      x.addEventListener('click', () => fr.remove(c.id));
      chip.append(inp, x);
      chips.append(chip);
    }
  }
  fr.onChange = renderChips;

  function openPop(): void {
    if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
    clear(pop);
    const inpWrap = el('div', { class: 'qam-flt-pop-inpwrap' });
    const inp = el('input', { type: 'text', class: 'qam-flt-pop-inp', placeholder: 'フィルター対象…' }) as HTMLInputElement;
    inpWrap.append(inp); pop.append(inpWrap);
    const list = el('div', { class: 'qam-flt-pop-list' }); pop.append(list);
    const renderList = (q: string): void => {
      clear(list);
      const used = new Set(fr.list().map((f) => f.id));
      const ql = q.toLowerCase();
      const cand = fr.cols.filter((c) => !used.has(c.id) && (!ql || c.label.toLowerCase().includes(ql)));
      if (!cand.length) { list.append(el('div', { class: 'qam-flt-pop-empty' }, [used.size >= fr.cols.length ? '全項目に条件設定済み' : '一致する項目なし'])); return; }
      for (const c of cand) {
        const item = el('div', { class: 'qam-flt-pop-item' });
        item.append(el('span', { class: 'qam-flt-pop-ic' }, [fltIcon(c)]), el('span', {}, [c.label]));
        item.addEventListener('click', () => {
          pop.classList.remove('on');
          fr.add(c.id); // → onChange=renderChips が走る
          setTimeout(() => { const ins = chips.querySelectorAll<HTMLElement>('.qam-flt-chip-val'); ins[ins.length - 1]?.focus(); }, 30);
        });
        list.append(item);
      }
    };
    inp.addEventListener('input', () => renderList(inp.value));
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, window.innerWidth - 300)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.classList.add('on');
    renderList('');
    setTimeout(() => inp.focus(), 30);
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); openPop(); });
  // 外側クリックで閉じる
  pop.addEventListener('click', (e) => e.stopPropagation());
  if (!filterOutsideBound) {
    document.addEventListener('click', () => document.getElementById('qam-flt-pop')?.classList.remove('on'));
    filterOutsideBound = true;
  }
  // 条件クリア: 検索・列フィルタ（履歴は期間・種別も）を一括リセット。
  const clearBtn = el('button', { class: 'btn btn--sm', title: '検索・列フィルタ' + (state.mode === 'history' ? '・期間・種別' : '') + 'を一括クリア', html: `${icon('x', 14)}<span>条件クリア</span>` });
  clearBtn.addEventListener('click', () => {
    state.q = '';
    fr.clear();
    if (state.mode === 'history') { state.histFrom = ''; state.histTo = ''; state.histStamp = ''; state.change = new Set(['added', 'modified', 'deleted']); }
    refresh();
  });
  toolbar.append(btn, clearBtn);
  renderChips();
}
let filterOutsideBound = false;

// 変更履歴CSV取込用: 識別名(タイトル/FQDN/ドメイン名/アカウント名)→ 現スナップショットの Qualys ID。
// CSV には Qualys ID が無いので名前で突き合わせる。未解決は '' を返し、呼び出し側で名前を ID にフォールバック。
async function buildIdResolver(entity: QamEntity): Promise<(rawName: string) => string> {
  const stamp = resolveAsof(await getSnapshotStamps(backend, entity));
  if (!stamp) return () => '';
  const snap = await readSnapshot(backend, entity, stamp);
  const map: Record<string, string> = {};
  for (const r of Object.values(snap?.records ?? {}) as QamRecord[]) {
    // user はログイン名でも引けるように。group/host は表示名(タイトル/FQDN)、domain は名前=キー。
    const names = entity === 'user' ? [r.scalar.USER_LOGIN, r.name, r.key] : [r.name, r.key];
    for (const n of names) if (n && !(n.toLowerCase() in map)) map[n.toLowerCase()] = r.key;
  }
  return (raw: string) => map[raw.trim().toLowerCase()] || '';
}

// 手入力メタ情報（Function/Location 等）の窓口。現状は group のみ。
async function buildAnnot(entity: QamEntity): Promise<AnnotApi | undefined> {
  if (entity !== 'group') return undefined;
  const map = await readAnnotations(backend, entity);
  return {
    get: (id, field) => map[id]?.[field] ?? '',
    save: async (id, field, v) => {
      await setAnnotation(backend, entity, id, field, v);
      const rec = (map[id] ??= {}); if (v) rec[field] = v; else delete rec[field];
      recordOp(`${field}編集`, `${id}: ${v || '(クリア)'}`, entity);
    },
  };
}

// host/domain が所属する AssetGroup の接続点IDを逆引き（group の HOST_IDS / DOMAIN_LIST から）。
// 戻り値: メンバーキー(host ID / domain名) → 接続点ID（複数AGはカンマ区切り全件）。
async function buildAgSetten(entity: QamEntity, asof: string): Promise<Record<string, string>> {
  if (entity !== 'host' && entity !== 'domain') return {};
  const gStamp = resolveAsof(await getSnapshotStamps(backend, 'group'), asof || undefined);
  if (!gStamp) return {};
  const gSnap = await readSnapshot(backend, 'group', gStamp);
  const acc: Record<string, Set<string>> = {};
  for (const g of Object.values(gSnap?.records ?? {}) as QamRecord[]) {
    const sid = settenId(g.name);
    if (!sid) continue; // 接続点IDとして妥当なタイトルのAGのみ
    const members = (entity === 'host' ? g.set.HOST_IDS : g.set.DOMAIN_LIST) ?? [];
    for (const m of members) (acc[m] ??= new Set()).add(sid);
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, [...v].sort().join(', ')]));
}

// 全資産一括 Excel: 全種別の最新スナップショットを種別ごとのシートに。フィルタ非適用（全件・全列）。
async function exportAllAssets(): Promise<void> {
  const sheets: Sheet[] = [];
  for (const e of ENTITIES) {
    const stamps = await getSnapshotStamps(backend, e.key);
    const stamp = resolveAsof(stamps); // 最新
    const comments = await commentApi(e.key);
    const cols = assetColumns(e.key, comments, await buildAgSetten(e.key, ''), await buildAnnot(e.key));
    let rows: QamRecord[] = [];
    if (stamp) rows = Object.values((await readSnapshot(backend, e.key, stamp))?.records ?? {}) as QamRecord[];
    sheets.push({ name: e.label, headers: cols.map((c) => c.label || c.id), rows: rows.map((r) => cols.map((c) => cellText(c, r))) });
  }
  if (sheets.every((s) => !s.rows.length)) { toast('エクスポートする資産がありません', 'info'); return; }
  exportXlsxBook(sheets, `QAM_全資産_${stampNow().slice(0, 10)}.xlsx`);
  toast('全資産Excelを出力しました', 'ok');
}

// エクスポート（CSV / Excel）＋列表示ボタン。exportRef.fn / columnRef.open は renderTable が描画時にセットする。
function addExportButtons(toolbar: HTMLElement, sheetName: string, exportRef: { fn?: () => ExportMatrix }, columnRef: { open?: (anchor: HTMLElement) => void }): void {
  const fname = (ext: string) => `QAM_${sheetName}_${state.entity}_${stampNow().slice(0, 10)}.${ext}`;
  const sheet = (m: ExportMatrix) => ({ name: sheetName, headers: m.headers, rows: m.rows });
  const mk = (label: string, run: (s: ReturnType<typeof sheet>, fn: string) => void, ext: string) => {
    const b = el('button', { class: 'btn btn--sm', html: `${icon('download', 14)}<span>${label}</span>` });
    b.addEventListener('click', () => {
      const m = exportRef.fn?.();
      if (!m || !m.rows.length) { toast('エクスポートする行がありません', 'info'); return; }
      try { run(sheet(m), fname(ext)); } catch (e) { toast('エクスポートに失敗: ' + (e as Error).message, 'error'); }
    });
    return b;
  };
  const colBtn = el('button', { class: 'btn btn--sm', title: '表示する列を選択', html: `${icon('settings', 14)}<span>列表示</span>` });
  colBtn.addEventListener('click', (e) => { e.stopPropagation(); columnRef.open?.(colBtn); });
  toolbar.append(el('div', { class: 'qam-export-group' }, [
    mk('CSV', exportCsv, 'csv'),
    mk('Excel', exportXlsx, 'xlsx'),
    colBtn,
  ]));
}

async function commentApi(entity: QamEntity): Promise<CommentApi> {
  const byId: Record<string, QamComment[]> = {};
  for (const c of await readComments(backend, entity)) (byId[c.id] ??= []).push(c);
  for (const id of Object.keys(byId)) byId[id].sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    byId,
    openThread,
    save: async (e, id, ts, text) => {
      if (ts) await editComment(backend, e, id, ts, text);
      else await addComment(backend, { ts: new Date().toISOString(), entity: e, id, author: localStorage.getItem(LS.author) || '', text });
      recordOp(ts ? 'メモ編集' : 'メモ追加', `${id}`, e);
      return (await readComments(backend, e, id)).sort((a, b) => a.ts.localeCompare(b.ts));
    },
  };
}

async function renderAssets(subbar: HTMLElement, count: HTMLElement, toolbar: HTMLElement, filterBar: HTMLElement, host: HTMLElement): Promise<void> {
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
    try { await deleteSnapshot(backend, state.entity, stamp); recordOp('スナップショット削除', fmtStamp(stamp), state.entity); state.asof = ''; toast('削除しました', 'ok'); refresh(); }
    catch (e) { toast('削除に失敗: ' + (e as Error).message, 'error'); }
  });
  subbar.append(delBtn);

  const snap = await readSnapshot(backend, state.entity, stamp);
  let rows = Object.values(snap?.records ?? {}) as QamRecord[];
  rows = rows.filter((r) => matchAsset(r, state.q));
  count.textContent = `${rows.length} 件 / ${fmtStamp(stamp)} 時点`;
  const comments = await commentApi(state.entity);
  const agSetten = await buildAgSetten(state.entity, state.asof);
  const annot = await buildAnnot(state.entity);
  const exportRef: { fn?: () => ExportMatrix } = {};
  const filterRef = {} as FilterRef;
  const columnRef: { open?: (a: HTMLElement) => void } = {};
  clear(host);
  host.append(renderTable({
    viewId: `assets.${state.entity}`, columns: assetColumns(state.entity, comments, agSetten, annot),
    rows, getKey: (r) => r.key, selected: state.selected, bulkActions: bulkComment, exportRef, filterRef, columnRef,
  }));
  addFilterUI(toolbar, filterBar, filterRef);
  addExportButtons(toolbar, '資産一覧', exportRef, columnRef);
  host.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
}

async function renderHistory(subbar: HTMLElement, count: HTMLElement, toolbar: HTMLElement, filterBar: HTMLElement, host: HTMLElement): Promise<void> {
  const all = await readHistory(backend, state.entity);

  // 左ペイン: 変更があった日に印を付けたカレンダー（クリックで from→to 範囲選択）
  const markedDays = new Set(all.map((e) => dateOfStamp(e.ts)));
  clear(leftCalHost);
  leftCalHost.append(el('div', { class: 'qam-navhead' }, ['変更カレンダー']));
  leftCalHost.append(renderCalendar({
    // カレンダーは日付単位。datetime 入力と共有する state は先頭10桁(YYYY-MM-DD)で渡す。
    marked: markedDays, from: state.histFrom.slice(0, 10), to: state.histTo.slice(0, 10),
    onRange: (f, t) => { state.histFrom = f; state.histTo = t; state.histStamp = ''; refresh(); },
  }));

  // 期間 from–to を「日付＋時刻」で直接入力（カレンダーの2点クリックと同じ state を共有）。
  // state.histFrom/histTo は 'YYYY-MM-DD'(カレンダー由来) か 'YYYY-MM-DDTHH:mm'(入力由来) を保持。
  const normalizeRange = (): void => { if (state.histFrom && state.histTo && state.histFrom > state.histTo) { const t = state.histFrom; state.histFrom = state.histTo; state.histTo = t; } };
  const toLocal = (s: string, end: boolean): string => (!s ? '' : s.length === 10 ? s + (end ? 'T23:59' : 'T00:00') : s.slice(0, 16));
  const mkDate = (val: string, end: boolean, set: (v: string) => void): HTMLInputElement => {
    const i = el('input', { type: 'datetime-local', class: 'in', style: 'width:auto' }) as HTMLInputElement;
    i.value = toLocal(val, end); // datetime-local は value プロパティで設定
    i.addEventListener('change', () => { set(i.value); normalizeRange(); state.histStamp = ''; refresh(); });
    return i;
  };
  toolbar.append(
    el('span', { class: 'qam-count' }, ['期間']),
    mkDate(state.histFrom, false, (v) => (state.histFrom = v)),
    el('span', { class: 'qam-count' }, ['〜']),
    mkDate(state.histTo, true, (v) => (state.histTo = v)),
  );
  for (const ch of ['added', 'modified', 'deleted']) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = state.change.has(ch);
    cb.addEventListener('change', () => { cb.checked ? state.change.add(ch) : state.change.delete(ch); refresh(); });
    const lab = el('label', { class: 'qam-chip', style: 'display:inline-flex;gap:4px;align-items:center;font-size:var(--fs-sm)' }, [cb, ({ added: '追加', modified: '変更', deleted: '削除' } as any)[ch]]);
    toolbar.append(lab);
  }

  // 期間: 開始のみ→以降 / 終了のみ→以前 / 両方→範囲 / 未指定→全件。日付のみ指定はその日全体(00:00〜23:59)。
  // 履歴の ts は秒精度 stamp 'YYYY-MM-DDTHH-mm-ss'。下限/上限を秒精度へ正規化して比較。
  const eventDT = (stamp: string): string => stamp.slice(0, 10) + 'T' + stamp.slice(11).replace(/-/g, ':');
  const bound = (s: string, end: boolean): string => (!s ? '' : s.length === 10 ? s + (end ? 'T23:59:59' : 'T00:00:00') : s.length === 16 ? s + (end ? ':59' : ':00') : s);
  const lo = bound(state.histFrom, false); const hi = bound(state.histTo, true);
  const inRange = (stamp: string): boolean => { const d = eventDT(stamp); return (!lo || d >= lo) && (!hi || d <= hi); };
  let events = all.filter((e) =>
    state.change.has(e.change)
    && inRange(e.ts)
    && matchQ([e.id, e.name, e.field, e.old, e.new, ...(e.added ?? []), ...(e.removed ?? [])]));
  events.reverse(); // 新しい順を既定に
  const fmt = (s: string): string => s.replace('T', ' ');
  const span = (state.histFrom || state.histTo) ? ` / ${state.histFrom ? fmt(state.histFrom) : '最古'}〜${state.histTo ? fmt(state.histTo) : '最新'}` : '';
  count.textContent = `${events.length} 件${span}`;
  const comments = await commentApi(state.entity);
  const exportRef: { fn?: () => ExportMatrix } = {};
  const filterRef = {} as FilterRef;
  const columnRef: { open?: (a: HTMLElement) => void } = {};
  clear(host);
  host.append(renderTable({
    viewId: `history.${state.entity}`, columns: historyColumns(state.entity, comments),
    rows: events, getKey: (e: QamEvent) => e.eid, selected: state.selected, exportRef, filterRef, columnRef,
    bulkActions: histBulk,
  }));
  addFilterUI(toolbar, filterBar, filterRef);
  addExportButtons(toolbar, '変更履歴', exportRef, columnRef);
  host.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
}

// 操作履歴ビュー: 登録/削除/変更などの操作を 作業者・日時つきで一覧表示（全種別共通）。
async function renderOps(subbar: HTMLElement, count: HTMLElement, toolbar: HTMLElement, filterBar: HTMLElement, host: HTMLElement): Promise<void> {
  clear(leftCalHost);
  const entLabel = (k?: QamEntity): string => (k ? ENTITIES.find((e) => e.key === k)?.label ?? k : '');
  const rows = (await readOps(backend)).reverse() // 新しい順
    .filter((o) => matchQ([o.author, o.action, o.entity, o.detail, o.ts]));
  count.textContent = `${rows.length} 件`;
  const cols: Column[] = [
    { id: 'ts', label: '操作日時', mono: true, render: (o: QamOp) => esc(o.ts.slice(0, 19).replace('T', ' ')), sortVal: (o: QamOp) => o.ts },
    { id: 'author', label: '作業者', render: (o: QamOp) => esc(o.author || '(未設定)') },
    { id: 'action', label: '操作', render: (o: QamOp) => esc(o.action) },
    { id: 'entity', label: '対象', render: (o: QamOp) => esc(entLabel(o.entity)) },
    { id: 'detail', label: '詳細', render: (o: QamOp) => esc(o.detail) },
  ];
  const exportRef: { fn?: () => ExportMatrix } = {};
  const filterRef = {} as FilterRef;
  const columnRef: { open?: (a: HTMLElement) => void } = {};
  clear(host);
  host.append(renderTable({
    viewId: 'ops', columns: cols, rows, getKey: (o: QamOp) => `${o.ts}|${o.action}|${o.detail}|${o.author}`,
    selected: state.selected, exportRef, filterRef, columnRef,
  }));
  addFilterUI(toolbar, filterBar, filterRef);
  addExportButtons(toolbar, '操作履歴', exportRef, columnRef);
  host.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
}

const emptyState = (t: string, d: string): HTMLElement => el('div', { class: 'qam-empty' }, [el('div', { class: 'qam-empty-title' }, [t]), el('div', {}, [d])]);

function bulkComment(keys: string[]): HTMLElement[] {
  const b = el('button', { class: 'btn btn--sm', html: `${icon('message', 14)}<span>選択にコメント</span>` });
  b.addEventListener('click', () => openThread(state.entity, keys[0]));
  return keys.length === 1 ? [b] : [];
}

// 変更履歴の手動削除（選択した eid を history から除去）。
function histBulk(keys: string[]): HTMLElement[] {
  const b = el('button', { class: 'btn btn--sm btn--danger', html: `${icon('x', 14)}<span>選択した履歴を削除</span>` });
  b.addEventListener('click', async () => {
    if (!(await confirmModal('変更履歴の削除', `選択した ${keys.length} 件の変更履歴を削除します。よろしいですか？（元に戻せません）`, '削除'))) return;
    try { const n = await removeHistoryEvents(backend, state.entity, keys); recordOp('変更履歴削除', `${n}件`, state.entity); state.selected.clear(); toast(`変更履歴を ${n} 件削除しました`, 'ok'); refresh(); }
    catch (e) { toast('削除に失敗: ' + (e as Error).message, 'error'); }
  });
  return [b];
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
      const c: QamComment = { ts: new Date().toISOString(), entity, id, author: localStorage.getItem(LS.author) || '', text };
      await addComment(backend, c); ta.value = ''; await reload(); toast('コメントを追加しました', 'ok');
      recordOp('メモ追加', `${id}`, entity);
    } catch (e) { toast('コメントの追加に失敗しました: ' + (e as Error).message, 'error'); }
    finally { send.removeAttribute('disabled'); }
  }
  send.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => { if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });
  openModal({ title: '作業履歴コメント', body });
  await reload();
}

// ---- ingest ----
// 重複確認の方針を取込ラン内で共有（「すべて」取込で一件ごとに聞かず最初の1回だけ確認）。
interface DupPolicy { decided: boolean; proceed: boolean }
async function commitOne(snap: { entity: QamEntity; datetime: string; records: any }, raw?: string, dup?: DupPolicy): Promise<void> {
  const cfg = await getConfig();
  // 取込日時 = XML の DATETIME 由来。重複チェック: 同 stamp=上書き / 同日=別取込として追加。
  const stamp = datetimeToStamp(snap.datetime);
  const existing = await getSnapshotStamps(backend, snap.entity);
  const sameStamp = existing.includes(stamp);
  const sameDay = !sameStamp && existing.some((s) => dateOfStamp(s) === dateOfStamp(stamp));
  if (sameStamp || sameDay) {
    let proceed: boolean;
    if (dup?.decided) {
      proceed = dup.proceed; // ラン内で確認済み → 同じ判断を引き継ぐ（再確認しない）
    } else {
      proceed = sameStamp
        ? await confirmModal('既に取込済み（同じ取込日時）', `${fmtStamp(stamp)} は既に取り込まれています。上書きしますか？（このラン内の重複は以降確認しません）`)
        : await confirmModal('同じ日に取込済み', `${dateOfStamp(stamp)} に取込済みです。別の取込として追加しますか？（前のスナップショットは残ります。このラン内の重複は以降確認しません）`);
      if (dup) { dup.decided = true; dup.proceed = proceed; }
    }
    if (!proceed) { toast(`${snap.entity}: 取込を中止しました`, 'info'); return; }
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
  recordOp('取込', `${fmtStamp(res.stamp)}: ${res.currCount.toLocaleString()}件 (${sum})`, snap.entity);
}

// Qualys アカウント/パスワード未登録時の登録モーダル。保存して {user,pass} を返す。取消は null。
function promptQualysCreds(curUser: string, curPass: string): Promise<{ user: string; pass: string } | null> {
  return new Promise((resolve) => {
    let done = false;
    const u = el('input', { class: 'in', value: curUser, placeholder: 'Qualys アカウント' }) as HTMLInputElement;
    const p = el('input', { class: 'in', type: 'password', value: curPass, placeholder: 'Qualys パスワード' }) as HTMLInputElement;
    const body = el('div', {}, [
      el('div', { style: 'margin-bottom:var(--s-4)' }, [callout('Qualys のアカウントとパスワードが未登録です。入力してください（個人設定としてこのブラウザに保存されます）。')]),
      el('div', { class: 'qam-field' }, [el('label', {}, ['Qualys アカウント']), u]),
      el('div', { class: 'qam-field' }, [el('label', {}, ['Qualys パスワード']), p]),
    ]);
    openModal({
      title: 'Qualys 認証情報の登録', body, primaryLabel: '保存して続行',
      onPrimary: () => {
        const user = u.value.trim(); const pass = p.value;
        if (!user || !pass) { toast('アカウントとパスワードを入力してください', 'error'); return false; }
        localStorage.setItem(LS.qualysUser, user); localStorage.setItem(LS.qualysPass, pass);
        done = true; resolve({ user, pass }); return true;
      },
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

function confirmModal(title: string, message: string, primaryLabel = '取り込む'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title, body: el('div', { style: 'user-select:text' }, [message]), primaryLabel,
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
  const histBtn = el('button', { class: 'btn btn--sm' }, ['変更履歴CSV']);
  const prog = el('div', { class: 'qam-progress', style: 'display:none' });
  seg.append(apiBtn, xmlBtn, histBtn); body.append(seg, panel, prog);

  const labelOf = (k: QamEntity): string => ENTITIES.find((e) => e.key === k)?.label ?? k;
  function setProg(msg: string, busy: boolean): void {
    clear(prog); prog.style.display = 'flex';
    prog.append(busy ? el('span', { class: 'qam-spin' }) : el('span', { html: icon('check', 16) }), el('span', { class: 'qam-prog-msg' }, [msg]));
  }

  function showApi(): void {
    apiBtn.className = 'btn btn--sm btn--primary'; xmlBtn.className = 'btn btn--sm'; histBtn.className = 'btn btn--sm';
    clear(panel);
    const sel = el('select', { class: 'in' }) as HTMLSelectElement;
    sel.append(el('option', { value: 'all' }, ['すべて']));
    ENTITIES.forEach((e) => sel.append(el('option', { value: e.key }, [e.label])));
    const go = el('button', { class: 'btn btn--primary', html: `${icon('download', 16)}<span>ダウンロードして取込</span>` });
    go.addEventListener('click', async () => {
      go.setAttribute('disabled', 'true'); sel.setAttribute('disabled', 'true');
      try {
        const cfg = await getConfig();
        // アカウント・パスワードは個人設定(ブラウザ保持)。旧 env 設定があれば後方互換でフォールバック。
        const creds = { base: cfg.qualysBase, user: localStorage.getItem(LS.qualysUser) || cfg.qualysUser || '', pass: localStorage.getItem(LS.qualysPass) || '', proxy: cfg.proxy };
        if (!creds.base) { setProg('設定で Qualys 接続先(POD)を入力してください', false); toast('接続先が未設定です', 'error'); return; }
        // アカウント/パスワードが未設定なら、その場で登録を促す（保存して続行）。
        if (!creds.user || !creds.pass) {
          const got = await promptQualysCreds(creds.user, creds.pass);
          if (!got) { setProg('Qualys アカウント/パスワードが未登録のため中止しました', false); return; }
          creds.user = got.user; creds.pass = got.pass;
        }
        const kinds = sel.value === 'all' ? ENTITIES.map((e) => e.key) : [sel.value as QamEntity];
        // ダウンロード前の重複チェック: 対象種別に本日分の取込が既にあれば、ダウンロード前に1回だけ確認する。
        const today = dateOfStamp(stampNow());
        const dupKinds: QamEntity[] = [];
        for (const k of kinds) {
          if ((await getSnapshotStamps(backend, k)).some((s) => dateOfStamp(s) === today)) dupKinds.push(k);
        }
        const dup: DupPolicy = { decided: false, proceed: false };
        if (dupKinds.length) {
          const ok = await confirmModal('本日分は取込済み', `${dupKinds.map(labelOf).join(' / ')} は本日(${today})分が既に取り込まれています。ダウンロードして取り込みますか？（同じ取込日時なら上書き、別時刻なら別取込として追加）`);
          if (!ok) { setProg('取込を中止しました', false); toast('取込を中止しました', 'info'); return; }
          dup.decided = true; dup.proceed = true; // 確認済み → 各 commit では再確認しない
        }
        // 取得は Basic 認証のみ（セッションCookieは環境により 401 で拒否されるため使わない）。
        setRelayBusy(true); // 取得中は死活ポーリングを止める（単一スレッド relay の誤検知防止）
        for (const k of kinds) {
          setProg(`${labelOf(k)}: ダウンロード中…`, true);
          const dl = await downloadEntity(k, creds, (p) => setProg(`${labelOf(k)}: ${p.page} ページ目・${p.records.toLocaleString()} 件取得…`, true));
          setProg(`${labelOf(k)}: 差分計算・保存中…（${Object.keys(dl.snapshot.records).length.toLocaleString()} 件）`, true);
          await commitOne(dl.snapshot, dl.raw, dup);
        }
        setProg('完了しました', false);
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { setRelayBusy(false); go.removeAttribute('disabled'); sel.removeAttribute('disabled'); }
    });
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['取得対象']), sel]), go);
  }
  function showXml(): void {
    xmlBtn.className = 'btn btn--sm btn--primary'; apiBtn.className = 'btn btn--sm'; histBtn.className = 'btn btn--sm';
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
  // 既存の変更履歴を CSV で取り込む（現在は AssetGroup のみ。種別ごとに個別指定）。
  function showHist(): void {
    histBtn.className = 'btn btn--sm btn--primary'; apiBtn.className = 'btn btn--sm'; xmlBtn.className = 'btn btn--sm';
    clear(panel);
    const sel = el('select', { class: 'in' }) as HTMLSelectElement;
    ENTITIES.forEach((e) => sel.append(el('option', { value: e.key, selected: e.key === 'group' }, [e.label])));
    const file = el('input', { type: 'file', accept: '.csv', class: 'in' }) as HTMLInputElement;
    const go = el('button', { class: 'btn btn--primary', html: `${icon('inbox', 16)}<span>履歴を取込</span>` });
    go.addEventListener('click', async () => {
      if (!file.files?.length) { toast('CSV ファイルを選択してください', 'error'); return; }
      const entity = sel.value as QamEntity;
      go.setAttribute('disabled', 'true');
      try {
        setProg('解析中…', true);
        const resolveId = await buildIdResolver(entity); // 名前→Qualys ID（接続点IDは ID にしない）
        const events = parseHistoryCsv(entity, await file.files[0].text(), resolveId);
        setProg(`変更履歴を取込中…（${events.length.toLocaleString()} 行）`, true);
        const n = await importHistory(backend, entity, events);
        setProg(`完了しました（${n.toLocaleString()} 件追加 / ${(events.length - n).toLocaleString()} 件は重複でスキップ）`, false);
        toast(`変更履歴を ${n.toLocaleString()} 件取り込みました`, 'ok');
        recordOp('変更履歴CSV取込', `${n.toLocaleString()}件追加`, entity);
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { go.removeAttribute('disabled'); }
    });
    const hint = el('div', { class: 'qam-count', style: 'margin-top:var(--s-3);user-select:text' });
    const setHint = (): void => { clear(hint); hint.append(`CSVヘッダ: ${HIST_HEADER_HINT[sel.value as QamEntity]}`); };
    sel.addEventListener('change', setHint); setHint();
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['対象（種別ごとに個別取込）']), sel]), el('div', { class: 'qam-field' }, [el('label', {}, ['変更履歴 CSV']), file]), hint, go);
  }
  apiBtn.addEventListener('click', showApi); xmlBtn.addEventListener('click', showXml); histBtn.addEventListener('click', showHist);
  showApi();
  openModal({ title: '取り込み', body });
}

// ---- settings ----
// Spira 風に分類（個人設定 / 共通設定 / 開発者）。左ペインで分類を選び右ペインに項目を表示。
async function openSettings(): Promise<void> {
  const cfg = await getConfig();
  const field = (label: string, input: HTMLElement, hint?: string) =>
    el('div', { class: 'qam-field' }, [el('label', {}, [label]), input, ...(hint ? [callout(hint)] : [])]);
  // 入力は一度だけ生成（ペイン切替で値は保持）。
  const base = el('input', { class: 'in', value: cfg.qualysBase || '', placeholder: 'https://YOUR-POD.qualysapi.example.com' }) as HTMLInputElement;
  // アカウントは個人設定（ブラウザ保持）。旧 env(cfg.qualysUser) があれば移行用に初期表示。
  const user = el('input', { class: 'in', value: localStorage.getItem(LS.qualysUser) || cfg.qualysUser || '' }) as HTMLInputElement;
  const proxy = el('input', { class: 'in', value: cfg.proxy || '', placeholder: 'http://proxy:8080' }) as HTMLInputElement;
  const ret = el('input', { class: 'in', type: 'number', min: '1', value: String(cfg.retentionDays || 90) }) as HTMLInputElement;
  const pass = el('input', { class: 'in', type: 'password', value: localStorage.getItem(LS.qualysPass) || '' }) as HTMLInputElement;
  const author = el('input', { class: 'in', value: localStorage.getItem(LS.author) || '', placeholder: '例: 山田' }) as HTMLInputElement;
  const theme = el('select', { class: 'in' }) as HTMLSelectElement;
  ([['', 'システム既定'], ['light', 'ライト'], ['dark', 'ダーク']] as [string, string][])
    .forEach(([v, t]) => theme.append(el('option', { value: v, selected: (localStorage.getItem(LS.theme) || '') === v }, [t])));
  const fontsize = el('select', { class: 'in' }) as HTMLSelectElement;
  ([['lg', '大'], ['md', '中'], ['sm', '小']] as [string, string][])
    .forEach(([v, t]) => fontsize.append(el('option', { value: v, selected: (localStorage.getItem(LS.fontsize) || 'md') === v }, [t])));
  // 文字サイズはその場で反映（＋保存）。保存ボタンを待たない。
  fontsize.addEventListener('change', () => { localStorage.setItem(LS.fontsize, fontsize.value); document.documentElement.dataset.fontsize = fontsize.value; });

  // 開発者: データのリセット（資産データ/履歴/メモを選んで全削除）。
  const ckSnap = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const ckHist = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const ckCmt = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const ckRow = (cb: HTMLInputElement, label: string) => el('label', { class: 'qam-chip', style: 'display:inline-flex;gap:6px;align-items:center;font-size:var(--fs-sm);margin-right:var(--s-4)' }, [cb, label]);
  const dataResetBtn = el('button', { class: 'btn btn--sm btn--danger' }, ['選択したデータをリセット']);
  dataResetBtn.addEventListener('click', async () => {
    const opts = { snapshots: ckSnap.checked, history: ckHist.checked, comments: ckCmt.checked };
    if (!opts.snapshots && !opts.history && !opts.comments) { toast('リセット対象を選択してください', 'error'); return; }
    const names = [opts.snapshots && '資産データ', opts.history && '変更履歴', opts.comments && 'メモ'].filter(Boolean).join('・');
    if (!(await confirmModal('データのリセット', `${names} を全件削除します。元に戻せません。よろしいですか？`, '削除'))) return;
    try {
      await resetData(backend, opts);
      recordOp('データリセット', names);
      ckSnap.checked = false; ckHist.checked = false; ckCmt.checked = false;
      toast(`${names} を削除しました`, 'ok'); refresh();
    } catch (e) { toast('リセットに失敗: ' + (e as Error).message, 'error'); }
  });
  const dataResetBox = el('div', {}, [
    el('div', { style: 'margin-bottom:var(--s-3)' }, [ckRow(ckSnap, '資産データ(スナップショット)'), ckRow(ckHist, '変更履歴'), ckRow(ckCmt, 'メモ(コメント)')]),
    dataResetBtn,
  ]);

  // 開発者: 登録情報のリセット（接続設定・認証・記入者名を初期化。資産データ/履歴は消さない）。
  const resetBtn = el('button', { class: 'btn btn--sm btn--danger' }, ['登録情報をリセット']);
  resetBtn.addEventListener('click', async () => {
    if (!(await confirmModal('登録情報のリセット', '接続先POD・Qualysアカウント・パスワード・プロキシ・記入者名を初期化します。取り込んだ資産データ・変更履歴・メモは消えません。よろしいですか？', 'リセット'))) return;
    try {
      await setConfig({ qualysBase: '', proxy: '', retentionDays: 90 });
      localStorage.removeItem(LS.qualysUser); localStorage.removeItem(LS.qualysPass); localStorage.removeItem(LS.author);
      base.value = ''; user.value = ''; proxy.value = ''; ret.value = '90'; pass.value = ''; author.value = '';
      toast('登録情報をリセットしました', 'ok');
    } catch (e) { toast('リセットに失敗: ' + (e as Error).message, 'error'); }
  });

  const cats: { id: string; label: string; pane: () => HTMLElement[] }[] = [
    { id: 'personal', label: '個人設定', pane: () => [field('記入者名（メモ・操作履歴の作成者）', author), field('テーマ', theme), field('文字サイズ', fontsize), field('Qualys アカウント', user), field('Qualys パスワード（このブラウザに保存）', pass, 'Qualys API 認証用。共有 env ではなくこのブラウザにのみ保存します。')] },
    { id: 'common', label: '共通設定', pane: () => [field('Qualys 接続先 POD', base), field('プロキシ URL', proxy), field('保存期間（日）', ret)] },
    { id: 'dev', label: '開発者', pane: () => [
      field('データのリセット', dataResetBox, '選択した種類を全件削除（取り込んだデータそのものを消去。元に戻せません）'),
      field('登録情報のリセット', resetBtn, '接続設定・認証情報・記入者名を初期化（資産データ/履歴/メモは対象外）'),
      field('ビルド', el('div', { class: 'qam-count', style: 'user-select:text' }, [`${BUILD}${BUILDTIME ? '  (' + BUILDTIME + ')' : ''}`])),
    ] },
  ];
  const nav = el('div', { class: 'qam-settings-nav' });
  const paneEl = el('div', { class: 'qam-settings-pane' });
  const select = (id: string): void => {
    clear(paneEl); cats.find((c) => c.id === id)!.pane().forEach((n) => paneEl.append(n));
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String((b as HTMLElement).dataset.cat === id)));
  };
  cats.forEach((c) => { const b = el('button', { dataset: { cat: c.id } }, [c.label]); b.addEventListener('click', () => select(c.id)); nav.append(b); });
  const body = el('div', { class: 'qam-settings' }, [nav, paneEl]);
  select('personal');

  openModal({
    title: '設定', body, primaryLabel: '保存',
    onPrimary: async () => {
      try {
        await setConfig({ qualysBase: base.value.trim(), proxy: proxy.value.trim(), retentionDays: parseInt(ret.value, 10) || 90 });
        if (user.value.trim()) localStorage.setItem(LS.qualysUser, user.value.trim()); else localStorage.removeItem(LS.qualysUser);
        if (pass.value) localStorage.setItem(LS.qualysPass, pass.value); else localStorage.removeItem(LS.qualysPass);
        if (author.value.trim()) localStorage.setItem(LS.author, author.value.trim()); else localStorage.removeItem(LS.author);
        if (theme.value) localStorage.setItem(LS.theme, theme.value); else localStorage.removeItem(LS.theme);
        document.documentElement.dataset.theme = theme.value || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        localStorage.setItem(LS.fontsize, fontsize.value); document.documentElement.dataset.fontsize = fontsize.value;
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

// 中継サーバが起動していなければ警告モーダルを出す（起動後に「再接続」で続行）。
let relayModal: { close: () => void } | null = null; // 表示中の中継ダウンモーダル（多重表示防止）
let relayBusy = 0; // 取込/インポート等の実行中（単一スレッド relay が応答できずポーリング誤検知するのを防ぐ）
const setRelayBusy = (on: boolean): void => { relayBusy += on ? 1 : -1; };

function showRelayDownModal(): void {
  if (relayModal) return; // 既に表示中なら何もしない
  const body = el('div', {}, [
    el('div', { style: 'display:flex;gap:var(--s-3);align-items:flex-start' }, [
      el('span', { style: 'color:var(--danger);flex:none', html: icon('alert', 20) }),
      el('div', {}, ['QAM のローカル中継サーバ（127.0.0.1）に接続できません。データの読み書きには中継サーバが必要です。']),
    ]),
    el('div', { style: 'margin-top:var(--s-4)' }, [callout('qam-start.bat（または qam-start.ps1）を実行して中継サーバを起動してから、「再接続」を押してください。')]),
  ]);
  relayModal = openModal({
    title: '中継サーバに接続できません',
    body,
    primaryLabel: '再接続',
    onPrimary: async () => {
      if (await checkRelay()) { relayModal = null; toast('中継サーバに接続しました', 'ok'); refresh(); return true; }
      toast('まだ接続できません。中継サーバの起動を確認してください', 'error'); return false;
    },
    onClose: () => { relayModal = null; },
  });
}

// 30秒間隔で relay を死活監視。落ちていたら警告、復帰したら自動でモーダルを閉じる。
// 取込/インポート中(relayBusy>0)は単一スレッド relay が応答できず誤検知するのでスキップ。
function startRelayPolling(): void {
  setInterval(async () => {
    if (relayBusy > 0) return;
    const ok = await checkRelay();
    if (!ok) { showRelayDownModal(); return; }
    if (relayModal) { relayModal.close(); relayModal = null; toast('中継サーバに再接続しました', 'ok'); refresh(); }
  }, 30000);
}

// 初回起動: 記入者名が未設定なら設定モーダルを出す（操作履歴・メモの作業者に使う）。
function ensureAuthor(): Promise<void> {
  if (localStorage.getItem(LS.author)) return Promise.resolve();
  return new Promise((resolve) => {
    const inp = el('input', { class: 'in', placeholder: '例: 山田' }) as HTMLInputElement;
    onEnter(inp, () => { const v = inp.value.trim(); if (v) { localStorage.setItem(LS.author, v); } });
    const body = el('div', {}, [el('div', { class: 'qam-field' }, [
      el('label', {}, ['記入者名']),
      inp,
      callout('操作履歴やメモに「作業者」として記録されます。設定でいつでも変更できます。'),
    ])]);
    openModal({
      title: '記入者名の設定', body, primaryLabel: '保存',
      onPrimary: () => { const v = inp.value.trim(); if (!v) { toast('記入者名を入力してください', 'error'); return false; } localStorage.setItem(LS.author, v); resolve(); return true; },
      onClose: () => resolve(),
    });
  });
}

async function start(): Promise<void> {
  startRelayPolling(); // 30秒間隔で中継サーバを死活監視（落ちたら警告・復帰で自動クローズ）
  if (!(await checkRelay())) { showRelayDownModal(); return; }
  await ensureAuthor();
  refresh();
}
start();
