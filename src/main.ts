// QAM エントリ: レイアウト・状態・ビュー・取込/設定/コメント。
import css from './styles/app.css';
import { BUILD, BUILDTIME, ENTITIES, LS, fmtStamp, datetimeToStamp, stampNow, today } from './config';
import { el, esc, clear, onEnter } from './ui/dom';
import { icon } from './icons';
import { toast } from './ui/toast';
import { openModal } from './ui/modal';
import { renderTable, cellText, type ExportMatrix, type FilterRef, type Column } from './ui/table';
import { exportCsv, exportXlsx, exportXlsxBook, type Sheet } from './export';
import { renderCalendar } from './ui/calendar';
import { assetColumns, historyColumns, settenId, openEventProps, eventSetten, eventBeforeAfter, histFieldLabel, changeLabelOf, fmtJst, ASSET_DEFAULT_HIDDEN, HISTORY_DEFAULT_HIDDEN, type CommentApi, type AnnotApi } from './ui/columns';
import { backend, getConfig, setConfig, shutdownRelay, checkRelay, backupNow, restoreNow } from './relay';
import { downloadEntity, downloadIps, downloadInspection, createSchedule, createAssetGroup, findAssetGroup, findDomain, addDomain, addQualysUser, analyzeSubscriptionIps, diagnoseSubscriptionIps, type ScanType, type UserRole } from './qualys';
import { computeInspection, quarterOf, DEFAULT_AG_PATTERN } from './inspection';
import { renderInspectionView, inspectionEmpty } from './ui/views/inspection';
import { openScheduleForm } from './ui/views/schedule-form';
import type { ScheduleInput } from './schedule';
import { parseRegions, formatRegions, planProvision, buildAssetGroupParams, DEFAULT_REGIONS, type ProvisionInput } from './provision';
import { parseQualysXml } from './ingest/parse';
import { parseHistoryCsv, HIST_HEADER_HINT, parseCsv } from './ingest/history-csv';
import {
  getSnapshotStamps, resolveAsof, readSnapshot, readHistory, readComments, addComment, editComment, ingestSnapshot, deleteSnapshot, dateOfStamp, importHistory, readAnnotations, setAnnotation, setAnnotationsBulk, removeHistoryEvents, logOp, readOps, resetData, recordLicense, readLicenses, getInspectionDates, readInspectionAt, readInspectionLegacy, writeInspection, backupSlot, listBackups, hasBackup, pruneBackups, type QamOp,
} from './store';
import { prepareLicenseSeries, licenseChartSvg, type LicenseSample } from './ui/license-chart';
import type { QamComment, QamEntity, QamEvent, QamInspectionRaw, QamRecord, QamRecords } from './types';

// 操作履歴記録: 作業者(個人設定の記入者名)＋時刻で登録/削除/変更を残す。失敗しても本処理は止めない。
function recordOp(action: string, detail: string, entity?: QamEntity): void {
  const op: QamOp = { ts: new Date().toISOString(), author: localStorage.getItem(LS.author) || '', action, entity, detail };
  logOp(backend, op).catch(() => undefined);
}

const GUARD_RATIO = 0.5;

const state = {
  mode: 'assets' as 'assets' | 'history' | 'ops' | 'licenses' | 'inspection',
  entity: 'group' as QamEntity,
  asof: '',
  q: '',
  histFrom: '',
  histTo: '',
  histStamp: '',
  change: new Set(['added', 'modified', 'deleted']),
  selected: new Set<string>(),
  wrap: false,
  licenseHidden: new Set<number>(), // ライセンス推移グラフで非表示にした年度
  inspAsof: '',                     // 四半期検査で表示する取込日（空＝最新）
};

// Unique Hosts Scanned（Qualys）= 実際にスキャン済み（最終スキャン日時あり）の一意ホスト数。host 一覧から算出。
// ※ IPs in Subscription は host 一覧から算出できない（サブスクリプションの登録IPプール＝契約値）ので設定で手入力。
function uniqueHostsScanned(records: QamRecords): number {
  let n = 0;
  for (const r of Object.values(records)) if ((r.info.LAST_VULN_SCAN_DATETIME || '').trim()) n++;
  return n;
}
// 推移サンプル: licenses.jsonl（ips/scanned を長期保持）＋現存 host スナップショットから scanned を再算出して統合。
// ips（IPs in Subscription）は host 一覧から算出できないので licenses.jsonl の記録値を使う。
async function buildLicenseSamples(): Promise<LicenseSample[]> {
  const map = new Map<string, LicenseSample>();
  for (const s of await readLicenses(backend)) map.set(s.ts, s);
  for (const stamp of await getSnapshotStamps(backend, 'host')) {
    const snap = await readSnapshot(backend, 'host', stamp);
    if (snap) map.set(stamp, { ts: stamp, ips: map.get(stamp)?.ips ?? 0, scanned: uniqueHostsScanned(snap.records) });
  }
  return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

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
// ライセンス表示: Unique Hosts Scanned（スキャン済み・host一覧から算出）/ IPs in Subscription（契約の登録IP数・設定値）。
const licenseBadge = el('button', { class: 'qam-license', title: 'Unique Hosts Scanned（スキャン済み一意ホスト数）/ IPs in Subscription（契約の登録IP数・設定で入力）。クリックで推移を表示' });
licenseBadge.addEventListener('click', () => { state.mode = 'licenses'; state.selected.clear(); refresh(); });
async function updateLicenseBadge(): Promise<void> {
  const [stamps, lic] = await Promise.all([getSnapshotStamps(backend, 'host'), readLicenses(backend)]);
  const stamp = resolveAsof(stamps);
  const snap = stamp ? await readSnapshot(backend, 'host', stamp) : null;
  const scanned = snap ? uniqueHostsScanned(snap.records) : null;
  // IPs in Subscription: 直近に取得できた登録IP数（自動取得のみ。ライセンス上限とは別）。
  const ips = [...lic].reverse().find((s) => s.ips > 0)?.ips ?? 0;
  // clear→append は await を挟まず不可分に行う（検索等で本関数が連続発火しても重複表示しないため）。
  clear(licenseBadge);
  licenseBadge.append(
    el('span', { class: 'qam-license-cap' }, ['Scanned / IPs in Subscription']),
    el('span', { class: 'qam-license-num' }, [`${scanned == null ? '—' : scanned.toLocaleString()} / ${ips ? ips.toLocaleString() : '—'}`]),
  );
}
topbar.append(
  el('div', { class: 'qam-brandwrap' }, [
    el('span', { class: 'qam-badge' }, ['N']),
    el('span', { class: 'qam-brand' }, ['QAM']),
    el('span', { class: 'qam-subtitle' }, ['Qualys Asset Management']),
  ]),
  el('span', { class: 'qam-build', title: BUILDTIME ? `ビルド日時: ${BUILDTIME}` : '' }, [`build ${BUILD}${BUILDTIME ? ` (${BUILDTIME})` : ''}`]),
  licenseBadge,
  ingestBtn,
  exportAllBtn,
  iconBtn('refresh', '更新', refresh),
  iconBtn('help', 'ヘルプ', openHelp),
  iconBtn('settings', '設定', openSettings),
  iconBtn('logout', '終了', doShutdown),
);

function renderLeft(): void {
  clear(left);
  left.append(el('div', { class: 'qam-navhead' }, ['ビュー']));
  const nav = el('div', { class: 'qam-nav' });
  const modes: [typeof state.mode, string, string][] = [['assets', '資産一覧', 'file'], ['history', '変更履歴', 'refresh'], ['inspection', '四半期検査', 'check'], ['licenses', 'ライセンス数推移', 'trend'], ['ops', '操作履歴', 'message']];
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
  updateLicenseBadge().catch(() => undefined); // 使用ライセンス数バッジを最新 host から更新（非同期・失敗は無視）
  clear(main);
  // tabs（操作履歴は全種別共通なので種別タブは出さない。行数維持のため空のタブ行は残す）
  const tableLike = state.mode === 'assets' || state.mode === 'history';
  const tabs = el('div', { class: 'qam-tabs' });
  if (tableLike) for (const e of ENTITIES) {
    const t = el('button', { class: 'qam-tab', 'aria-current': String(state.entity === e.key) }, [e.label]);
    t.addEventListener('click', () => { state.entity = e.key; state.selected.clear(); refresh(); });
    tabs.append(t);
  }
  // subbar
  const subbar = el('div', { class: 'qam-subbar' });
  const titles = { assets: '資産一覧', history: '変更履歴', ops: '操作履歴', licenses: 'ライセンス数推移', inspection: '四半期検査' } as const;
  const title = el('span', { class: 'qam-title' }, [titles[state.mode]]);
  const count = el('span', { class: 'qam-count' });
  subbar.append(title, count, el('span', { class: 'qam-spacer' }));
  // toolbar
  const toolbar = el('div', { class: 'qam-toolbar' });
  // 検索/全文表示は表ビュー用。ダッシュボード型（推移・四半期検査）では出さない。
  if (state.mode !== 'licenses' && state.mode !== 'inspection') {
    const search = el('div', { class: 'qam-search', html: icon('search', 14) });
    const sIn = el('input', { type: 'text', placeholder: '検索（ID / 名前 / IP / FQDN）', value: state.q }) as HTMLInputElement;
    onEnter(sIn, () => { state.q = sIn.value.trim(); refresh(); });
    sIn.addEventListener('change', () => { state.q = sIn.value.trim(); refresh(); });
    // クリアボタン。表示/非表示は visibility で切替（display を変えると入力時にボックス幅が変わるため）。
    const clearBtn = el('button', { class: 'qam-search-clear', 'aria-label': '検索をクリア', title: '検索をクリア', html: icon('x', 13) });
    const syncClear = (): void => { clearBtn.style.visibility = sIn.value ? 'visible' : 'hidden'; };
    // mousedown で処理＋preventDefault：input の blur→change→refresh が先に走ってボタンが消え、
    // 「1度押しただけでは効かない（2度押し必要）」になるのを防ぐ。
    clearBtn.addEventListener('mousedown', (e) => { e.preventDefault(); sIn.value = ''; state.q = ''; refresh(); });
    sIn.addEventListener('input', syncClear);
    search.append(sIn, clearBtn); toolbar.append(search);
    syncClear();
    // 全文表示トグル（列幅で折り返して全文表示）
    const wrapBtn = el('button', { class: state.wrap ? 'btn btn--sm btn--primary' : 'btn btn--sm', title: '列幅で折り返して全文表示' }, ['全文表示']);
    wrapBtn.addEventListener('click', () => {
      state.wrap = !state.wrap;
      wrapBtn.className = state.wrap ? 'btn btn--sm btn--primary' : 'btn btn--sm';
      main.querySelector('.qam-table')?.classList.toggle('qam-wrap', state.wrap);
    });
    toolbar.append(wrapBtn);
  }

  const filterBar = el('div', { class: 'qam-filterbar' });
  const scrollable = state.mode === 'licenses' || state.mode === 'inspection'; // 縦に積むダッシュボードはビュー全体をスクロール
  const tableHost = el('div', { style: 'min-height:0;overflow:' + (scrollable ? 'auto' : 'hidden') });
  tableHost.append(el('div', { class: 'qam-tablewrap' }, [skeleton()]));
  main.append(tabs, subbar, toolbar, filterBar, tableHost);

  if (state.mode === 'assets') await renderAssets(subbar, count, toolbar, filterBar, tableHost);
  else if (state.mode === 'history') await renderHistory(subbar, count, toolbar, filterBar, tableHost);
  else if (state.mode === 'licenses') await renderLicenses(count, tableHost);
  else if (state.mode === 'inspection') await renderInspection(count, tableHost);
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
      await ensureAuthor(); // 記載の直前に記入者名が未設定なら促す
      await setAnnotation(backend, entity, id, field, v);
      const rec = (map[id] ??= {}); if (v) rec[field] = v; else delete rec[field];
      recordOp(`${field}編集`, `${id}: ${v || '(クリア)'}`, entity);
    },
  };
}

// AssetGroup の手動値CSV取込: 接続点IDをキーに、一覧の列名で値列をマッチして注釈を上書き。
// 取込対象は API で取れない手動項目（部門/接続名称/拠点名称/コメント）。
const ASSET_VALUE_FIELDS: [string, RegExp][] = [
  ['EXT_CONN_NO', /外接番号|外接|ext.*conn/i],
  ['DIVISION', /事業場名|部門|division/i],
  ['FUNCTION', /function|接続名称|機能/i],
  ['LOCATION', /location|拠点/i],
  ['COMMENTS', /comments/i],
];
async function importAssetValues(text: string, onProgress?: (done: number, total: number, phase: 'scan' | 'save') => void): Promise<{ updated: number; unmatched: number; fields: string[] }> {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) throw new Error('CSV が空です');
  const header = rows[0].map((h) => h.trim());
  const idx = (re: RegExp): number => header.findIndex((h) => re.test(h));
  const sidCol = idx(/接続点ID/i);
  if (sidCol < 0) throw new Error('ヘッダに「接続点ID」が必要です');
  const fieldCols = ASSET_VALUE_FIELDS.map(([f, re]) => [f, idx(re)] as [string, number]).filter(([, i]) => i >= 0);
  if (!fieldCols.length) throw new Error('取り込める値列（部門/接続名称/拠点名称/コメント）がありません');
  // 接続点ID → group ID（最新スナップショットのタイトルから算出）
  const gStamp = resolveAsof(await getSnapshotStamps(backend, 'group'));
  const snap = gStamp ? await readSnapshot(backend, 'group', gStamp) : null;
  const sidToId: Record<string, string> = {};
  for (const g of Object.values(snap?.records ?? {}) as QamRecord[]) { const sid = settenId(g.name); if (sid) sidToId[sid] = g.key; }
  // 全行をメモリ上で集計し、注釈はまとめて1回だけ書き込む（1項目ごとの read+write を避ける）。
  const data = rows.slice(1);
  const total = data.length;
  const updates: { id: string; field: string; value: string }[] = [];
  let updated = 0; let unmatched = 0;
  for (let i = 0; i < total; i++) {
    const r = data[i];
    const get = (j: number): string => (j >= 0 ? (r[j] ?? '').trim() : '');
    const sid = get(sidCol);
    if (sid) {
      const gid = sidToId[sid];
      if (!gid) unmatched++;
      else { for (const [field, j] of fieldCols) updates.push({ id: gid, field, value: get(j) }); updated++; } // 上書き（空はクリア）
    }
    // 集計はメモリ操作で高速。500行ごとに進捗通知＋イベントループへ譲ってUIを更新。
    if (i % 500 === 0) { onProgress?.(i, total, 'scan'); await new Promise((res) => setTimeout(res)); }
  }
  onProgress?.(total, total, 'scan');
  onProgress?.(updated, updated, 'save');
  await setAnnotationsBulk(backend, 'group', updates); // ← 1回だけ書き込み
  return { updated, unmatched, fields: fieldCols.map(([f]) => f) };
}

// host/domain が所属する AssetGroup の接続点IDを逆引き。
// (1) group 側の HOST_IDS / DOMAIN_LIST から、(2) host 側の ASSET_GROUP_IDS からも補完（AG側が空でも辿れる）。
// 戻り値: メンバーキー(host ID / domain名) → 接続点ID（複数AGはカンマ区切り全件）。
async function buildAgSetten(entity: QamEntity, asof: string): Promise<Record<string, string>> {
  if (entity !== 'host' && entity !== 'domain') return {};
  const acc: Record<string, Set<string>> = {};
  const agIdToSetten: Record<string, string> = {}; // AssetGroup ID → 接続点ID
  // group スナップショットがあれば: タイトル→接続点ID と HOST_IDS/DOMAIN_LIST→メンバー紐付け。
  const gStamp = resolveAsof(await getSnapshotStamps(backend, 'group'), asof || undefined);
  const gSnap = gStamp ? await readSnapshot(backend, 'group', gStamp) : null;
  for (const g of Object.values(gSnap?.records ?? {}) as QamRecord[]) {
    const sid = settenId(g.name);
    if (!sid) continue; // 接続点IDとして妥当なタイトルのAGのみ
    agIdToSetten[g.key] = sid;
    const members = (entity === 'host' ? g.set.HOST_IDS : g.set.DOMAIN_LIST) ?? [];
    for (const m of members) (acc[m] ??= new Set()).add(sid);
  }
  // host は自身の所属AGからも補完。タイトルがあれば直接、無ければ AG ID→接続点ID で。
  // （group スナップショットが無くても host の AGタイトルだけで接続点IDを引ける）
  if (entity === 'host') {
    const hStamp = resolveAsof(await getSnapshotStamps(backend, 'host'), asof || undefined);
    const hSnap = hStamp ? await readSnapshot(backend, 'host', hStamp) : null;
    for (const h of Object.values(hSnap?.records ?? {}) as QamRecord[]) {
      for (const t of h.set.ASSET_GROUP_TITLES ?? []) { const sid = settenId(t); if (sid) (acc[h.key] ??= new Set()).add(sid); }
      for (const agId of h.set.ASSET_GROUP_IDS ?? []) { const sid = agIdToSetten[agId]; if (sid) (acc[h.key] ??= new Set()).add(sid); }
    }
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
    save: async (e, id, ts, text) => {
      await ensureAuthor(); // 記載の直前に記入者名が未設定なら促す
      if (ts) await editComment(backend, e, id, ts, text);
      else await addComment(backend, { ts: new Date().toISOString(), entity: e, id, author: localStorage.getItem(LS.author) || '', text });
      recordOp(ts ? 'メモ編集' : 'メモ追加', `${id}`, e);
      return (await readComments(backend, e, id)).sort((a, b) => a.ts.localeCompare(b.ts));
    },
  };
}

async function renderAssets(subbar: HTMLElement, count: HTMLElement, toolbar: HTMLElement, filterBar: HTMLElement, host: HTMLElement): Promise<void> {
  clear(leftCalHost); // 資産一覧モードではカレンダー非表示
  // User 一覧では Qualys へのユーザ登録ボタンを出す。
  if (state.entity === 'user') {
    const addBtn = el('button', { class: 'btn btn--sm btn--primary' }, ['＋ ユーザ登録']);
    addBtn.addEventListener('click', () => { Promise.resolve().then(openUserAdd).catch((e) => toast('ユーザ登録でエラー: ' + (e as Error).message, 'error')); });
    toolbar.append(addBtn);
  }
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
    await ensureAuthor(); // 削除（更新作業）の直前に記入者名が未設定なら促す
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
    rows, getKey: (r) => r.key, selected: state.selected, exportRef, filterRef, columnRef,
    defaultHidden: ASSET_DEFAULT_HIDDEN[state.entity],
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
  // 接続点ID等の列はイベントに保存された point-in-time の値で描画する（最新スナップショットは参照しない）。
  const exportRef: { fn?: () => ExportMatrix; rows?: () => QamEvent[] } = {};
  const filterRef = {} as FilterRef;
  const columnRef: { open?: (a: HTMLElement) => void } = {};
  clear(host);
  host.append(renderTable({
    viewId: `history.${state.entity}`, columns: historyColumns(state.entity, comments),
    rows: events, getKey: (e: QamEvent) => e.eid, selected: state.selected, exportRef, filterRef, columnRef,
    bulkActions: histBulk, onRowClick: (e: QamEvent) => openEventProps(e), // 行クリックで追加/削除/変更したアセットの情報を表示
    defaultHidden: HISTORY_DEFAULT_HIDDEN[state.entity],
  }));
  // CSV/Excel は各項目の変更前/変更後をそれぞれ列に展開（表示中＝フィルタ後の行が対象）。
  exportRef.fn = () => buildHistoryExport((exportRef.rows?.() ?? events) as QamEvent[], state.entity);
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
    { id: 'ts', label: '操作日時', mono: true, render: (o: QamOp) => esc(fmtJst(o.ts)), sortVal: (o: QamOp) => o.ts },
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

// ライセンス数推移ビュー: 年度（4月〜翌3月）ごとの折れ線を 12 ヶ月 x 軸に重ね描き。凡例で年度の表示/非表示を切替。
async function renderLicenses(count: HTMLElement, host: HTMLElement): Promise<void> {
  clear(leftCalHost);
  const [samples, cfg] = await Promise.all([buildLicenseSamples(), getConfig()]);
  const latest = samples.length ? samples[samples.length - 1].scanned : null;
  const ips = [...samples].reverse().find((s) => s.ips > 0)?.ips ?? 0; // IPs in Subscription（登録IP数・自動取得）。線には使わない。
  const cap = cfg.licenseLimit || 0; // ライセンス上限（env QAM_LICENSE_LIMIT）。破線はこちらを使う。
  const series = prepareLicenseSeries(samples);
  count.textContent = `${samples.length.toLocaleString()} サンプル / ${series.length} 年度`;
  clear(host);
  if (!samples.length) {
    host.append(emptyState('データがありません', 'Host を取り込むと、その時点の Unique Hosts Scanned を日時で記録します。'));
    return;
  }
  // 初期表示: 直近 2 年度のみ表示（古い年度は凡例で表示に切替）。既定適用はセッション内で一度だけ。
  if (!licenseDefaulted) { licenseDefaulted = true; if (series.length > 2) for (const s of series.slice(2)) state.licenseHidden.add(s.fy); }

  const wrap = el('div', { class: 'qam-lic' });
  const chartBox = el('div', { class: 'qam-lic-chart' });
  const legend = el('div', { class: 'qam-lic-legend' });
  const redraw = (): void => {
    clear(chartBox);
    const visible = new Set(series.filter((s) => !state.licenseHidden.has(s.fy)).map((s) => s.fy));
    chartBox.append(licenseChartSvg(series, visible, cap)); // 破線 = ライセンス上限（env）
  };
  for (const s of series) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = !state.licenseHidden.has(s.fy);
    cb.addEventListener('change', () => { cb.checked ? state.licenseHidden.delete(s.fy) : state.licenseHidden.add(s.fy); redraw(); });
    const sw = el('span', { class: 'qam-lic-swatch', style: `background:${s.color}` });
    legend.append(el('label', { class: 'qam-lic-legitem' }, [cb, sw, el('span', {}, [s.label])]));
  }
  // 数値サマリ（表・最新時点）。
  const stat = (k: string, v: string): HTMLElement => el('div', { class: 'qam-lic-stat' }, [el('span', { class: 'qam-lic-stat-k' }, [k]), el('span', { class: 'qam-lic-stat-v' }, [v])]);
  const summary = el('div', { class: 'qam-lic-summary' }, [
    stat('Unique Hosts Scanned（スキャン済・最新）', latest == null ? '—' : latest.toLocaleString()),
    stat('IPs in Subscription（登録IP数・自動取得）', ips ? ips.toLocaleString() : '—'),
    stat('ライセンス上限（設定）', cap ? cap.toLocaleString() : '—'),
    ...(cap ? [stat('残り（上限 − IPs in Subscription）', ips ? (cap - ips).toLocaleString() : '—')] : []),
  ]);
  const note = '折れ線 = Unique Hosts Scanned（実際にスキャン済みの一意ホスト数。host 一覧から算出）。'
    + '破線 = ライセンス上限（設定の QAM_LICENSE_LIMIT）。'
    + 'IPs in Subscription（登録IP総数）は API取込時に Qualys から自動取得し、上限とは別の値として表示。'
    + 'x 軸は年度（4月〜翌3月）の月。データの無い月は未記載。';
  const dupBox = await buildIpDupBox(); // IPs in Subscription の重複チェック（応答XMLがあれば）
  wrap.append(el('div', { class: 'qam-lic-note' }, [note]), summary, ...(dupBox ? [dupBox] : []), buildIpScopeDiagBox(), chartBox, legend);
  host.append(wrap);
  redraw();
}

// ---- 四半期検査ビュー ----
// 母集団は最新の AssetGroup スナップショット（再取得しない）。実施済み/スケジュールは
// inspection/latest.json のキャッシュを使い、「Qualys から取得」で更新する。
let inspectionBusy = false;

async function renderInspection(count: HTMLElement, host: HTMLElement): Promise<void> {
  clear(leftCalHost);
  const [cfg, stamps, dates] = await Promise.all([getConfig(), getSnapshotStamps(backend, 'group'), getInspectionDates(backend)]);
  // 表示する取込日（未指定＝最新）。指定日以前で最大の日付を採る（資産一覧の as-of と同じ考え方）。
  const asof = resolveAsof(dates, state.inspAsof) ?? '';
  const raw = asof ? await readInspectionAt(backend, asof) : await readInspectionLegacy(backend);
  // 母集団の AssetGroup も、その取込日以前で最大のスナップショットに合わせる（当時の登録状況で判定）。
  const stamp = resolveAsof(stamps, asof ? `${asof}T99` : undefined);
  const snap = stamp ? await readSnapshot(backend, 'group', stamp) : null;
  const pattern = cfg.inspectionAgPattern || DEFAULT_AG_PATTERN;
  const data = computeInspection(snap?.records ?? {}, raw, cfg.fiscalStartMonth || 4, pattern, new Date());
  count.textContent = `${data.quarter.label}／SCAN ${data.scan.length} 件・MAP ${data.map.length} 件`;
  clear(host);
  // AssetGroup が 1 件も無いときだけ空表示。パターン不一致で 0 件のときは本体を出す
  // （「対象母集団」セクションが、どの AssetGroup がなぜ対象外かを示すため）。
  if (!data.sources.agTotal) { host.append(inspectionEmpty(pattern)); return; }
  host.append(renderInspectionView({
    data, busy: inspectionBusy, dates, asof,
    onFetch: () => { void runInspectionFetch(); },
    onAsof: (d) => { state.inspAsof = d; refresh(); },
    onAddSchedule: () => { void openScheduleAdd(); },
  }));
}

// 検査登録（Qualys への書き込み）。AssetGroup 作成 → ドメイン登録 → スケジュール登録 の順に進める。
// 途中で失敗しても、そこまでに何ができたかを画面に出す（黙って中途半端な状態にしない）。
async function openScheduleAdd(): Promise<void> {
  await ensureAuthor(); // 書き込み操作なので作業者を先に確定させる
  const creds = await resolveQualysCreds();
  if (!creds) return;
  const cfg = await getConfig();
  const author = localStorage.getItem(LS.author) || '';
  openScheduleForm({
    today: dateOfStamp(stampNow()),
    regions: parseRegions(cfg.regions || ''),
    defaults: {
      scanOptionProfile: cfg.scanOptionProfile || '',
      mapOptionProfile: cfg.mapOptionProfile || '',
      scannerAppliance: cfg.scannerAppliance || 'External',
      timeZoneCode: cfg.scheduleTimeZone || 'JP',
    },
    confirm: (title, lines) => confirmModal(title, lines.join('\n'), '登録する'),
    submit: (p, scanInput, mapInput) => runProvision(creds, author, p, scanInput, mapInput),
    onDone: () => { refresh(); },
  });
}

// 既に同じものがある場合の選択肢。破壊的な既定を持たせず、必ず利用者に選ばせる。
type DupChoice = 'use' | 'rename' | 'cancel';
async function askDuplicate(what: string, name: string): Promise<{ choice: DupChoice; newName: string }> {
  const body = el('div', {}, [
    el('div', { style: 'margin-bottom:var(--s-4)' }, [callout(`${what}「${name}」は既に存在します。どうしますか？`)]),
  ]);
  const sel = el('select', { class: 'in' }) as HTMLSelectElement;
  sel.append(
    el('option', { value: 'use' }, ['既存をそのまま使う（新規作成しない）']),
    el('option', { value: 'rename' }, ['別の名前で作成する']),
    el('option', { value: 'cancel' }, ['登録を中止する']),
  );
  const rename = el('input', { class: 'in', value: `${name}-2` }) as HTMLInputElement;
  const renameField = el('div', { class: 'qam-field' }, [el('label', {}, ['新しい名前']), rename]);
  renameField.hidden = true;
  sel.addEventListener('change', () => { renameField.hidden = sel.value !== 'rename'; });
  body.append(el('div', { class: 'qam-field' }, [el('label', {}, ['対応']), sel]), renameField);
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title: '同名の登録があります', body, primaryLabel: '決定',
      onPrimary: () => {
        const choice = sel.value as DupChoice;
        if (choice === 'rename' && !rename.value.trim()) { toast('新しい名前を入力してください', 'error'); return false; }
        done = true; resolve({ choice, newName: rename.value.trim() }); return true;
      },
      onClose: () => { if (!done) resolve({ choice: 'cancel', newName: '' }); },
    });
  });
}

async function runProvision(
  creds: { base: string; user: string; pass: string; proxy: string },
  author: string, p: ProvisionInput, scanInput: ScheduleInput, mapInput: ScheduleInput,
): Promise<{ steps: string[] }> {
  const plan = planProvision(p);
  const steps: string[] = [];
  setRelayBusy(true); // 書き込み中は死活ポーリングを止める（単一スレッド relay の誤検知防止）
  try {
    let agTitle = plan.title;
    // 1) AssetGroup（同名は Qualys 側で一意制約に触れるので事前に確認する）
    if (await findAssetGroup(creds, agTitle)) {
      const d = await askDuplicate('AssetGroup', agTitle);
      if (d.choice === 'cancel') throw new Error('登録を中止しました');
      if (d.choice === 'rename') {
        agTitle = d.newName;
        await createAssetGroup(creds, { ...buildAssetGroupParams(p), title: agTitle }, author);
        steps.push(`AssetGroup「${agTitle}」を作成`);
      } else steps.push(`AssetGroup「${agTitle}」は既存を使用`);
    } else {
      await createAssetGroup(creds, buildAssetGroupParams(p), author);
      steps.push(`AssetGroup「${agTitle}」を作成`);
    }
    // 2) ドメイン（MAP を含むときのみ）
    let domain = plan.domain;
    if (plan.withMap && domain) {
      if (await findDomain(creds, domain)) {
        const d = await askDuplicate('ドメイン', domain);
        if (d.choice === 'cancel') throw new Error(`登録を中止しました（ここまで: ${steps.join(' / ')}）`);
        if (d.choice === 'rename') {
          domain = d.newName;
          await addDomain(creds, domain, author);
          steps.push(`ドメイン「${domain}」を登録`);
        } else steps.push(`ドメイン「${domain}」は既存を使用`);
      } else {
        await addDomain(creds, domain, author);
        steps.push(`ドメイン「${domain}」を登録`);
      }
    }
    // 3) スケジュール（名前を変えた場合は対象も差し替える）
    if (plan.withScan) {
      await createSchedule(creds, { ...scanInput, targets: [agTitle] }, author);
      steps.push('SCAN スケジュールを登録');
    }
    if (plan.withMap) {
      await createSchedule(creds, { ...mapInput, targets: [domain] }, author);
      steps.push('MAP スケジュールを登録');
    }
    recordOp('検査登録', steps.join(' / '));
    toast(`検査を登録しました: ${steps.join(' / ')}`, 'ok');
    return { steps };
  } catch (e) {
    // 途中まで進んでいたら、それも含めて理由を返す（フォームに表示される）。
    if (steps.length) recordOp('検査登録(中断)', `${steps.join(' / ')} / 失敗: ${(e as Error).message}`);
    throw new Error(steps.length ? `${(e as Error).message}（完了: ${steps.join(' / ')}）` : (e as Error).message);
  } finally { setRelayBusy(false); }
}

// 接続先と認証情報を解決（未設定ならその場で入力を促す）。取得・登録で共有する。
async function resolveQualysCreds(): Promise<{ base: string; user: string; pass: string; proxy: string } | null> {
  const cfg = await getConfig();
  const creds = { base: cfg.qualysBase, user: localStorage.getItem(LS.qualysUser) || cfg.qualysUser || '', pass: localStorage.getItem(LS.qualysPass) || '', proxy: cfg.proxy };
  if (!creds.base) { toast('設定で Qualys 接続先(POD)を入力してください', 'error'); return null; }
  if (!creds.user || !creds.pass) {
    const got = await promptQualysCreds(creds.user, creds.pass);
    if (!got) return null;
    creds.user = got.user; creds.pass = got.pass;
  }
  return creds;
}

// 取得した生XMLを raw/<日付>/ に保存する（応答の中身を後から確認できるように。IPs in Subscription と同じ作法）。
// 保存失敗は本処理を止めない。raw/ は .gitignore 済み・保存期間を過ぎれば剪定される。
async function saveInspectionRaw(raw: QamInspectionRaw): Promise<void> {
  const stamp = stampNow();
  const date = dateOfStamp(stamp);
  const files: [string, string][] = [
    ['scans', raw.scans], ['maps', raw.maps],
    ['scan-schedules', raw.scanSchedules], ['map-schedules', raw.mapSchedules],
  ];
  for (const [name, xml] of files) {
    if (!xml) continue;
    try { await backend.write(`raw/${date}/inspection-${name}-${stamp}.xml`, xml); }
    catch { /* XML保存失敗は本処理に影響させない */ }
  }
}

// Qualys から 実施済み/スケジュールの scan・map を取得してキャッシュし、再描画する。
async function runInspectionFetch(): Promise<void> {
  if (inspectionBusy) return;
  const cfg = await getConfig();
  const creds = await resolveQualysCreds();
  if (!creds) return;
  inspectionBusy = true;
  setRelayBusy(true); // 取得中は死活ポーリングを止める（単一スレッド relay の誤検知防止）
  await refresh();    // ボタンを「取得中…」表示に
  try {
    const q = quarterOf(new Date(), cfg.fiscalStartMonth || 4);
    const { raw, warnings } = await downloadInspection(creds, q.start);
    const today = dateOfStamp(stampNow());
    await writeInspection(backend, today, raw); // 取込日ごとに保持（同日再取得は上書き）
    await saveInspectionRaw(raw);               // 応答XMLを raw/<日付>/ に保存（原因調査用）
    state.inspAsof = '';                        // 取得直後は最新を表示する
    recordOp('四半期検査 取得', `${q.label} の実施済み/スケジュールを取得${warnings.length ? `（一部失敗: ${warnings.length} 件）` : ''}`);
    // 一部のエンドポイントが取れなくても表示はする。取れなかったものは理由を出す（黙って0件にしない）。
    if (warnings.length) toast(`一部を取得できませんでした — ${warnings.join(' / ')}`, 'error');
    else toast('四半期検査の状況を取得しました', 'ok');
  } catch (e) {
    toast('取得に失敗しました: ' + (e as Error).message, 'error');
  } finally {
    inspectionBusy = false;
    setRelayBusy(false);
    await refresh();
  }
}

// 直近の IPs in Subscription 応答XML（raw/<日付>/ips-*.xml の最新）を読む。無ければ null。
async function latestIpsXml(): Promise<string | null> {
  const dates = (await backend.list('raw')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const d of [...dates].reverse()) {
    const files = (await backend.list(`raw/${d}`)).filter((f) => /^ips-.*\.xml$/.test(f)).sort();
    if (files.length) return backend.read(`raw/${d}/${files[files.length - 1]}`);
  }
  return null;
}

// IP重複チェックのパネル。単体×レンジ・レンジ×レンジ・完全重複を検出して表示。
async function buildIpDupBox(): Promise<HTMLElement | null> {
  const xml = await latestIpsXml();
  if (!xml) return null;
  const rep = analyzeSubscriptionIps(xml);
  const stat = (k: string, v: string): HTMLElement => el('div', { class: 'qam-lic-stat' }, [el('span', { class: 'qam-lic-stat-k' }, [k]), el('span', { class: 'qam-lic-stat-v' }, [v])]);
  const box = el('div', { class: 'qam-lic-summary' }, [
    stat('IP重複チェック（一意 / 単純合計 / 重複）', `${rep.unique.toLocaleString()} / ${rep.rawSum.toLocaleString()} / ${rep.duplicates.toLocaleString()}`),
  ]);
  if (rep.duplicates > 0) {
    box.append(el('div', { class: 'qam-lic-note' }, [`重複IPが ${rep.duplicates.toLocaleString()} 件あります（一意IP数が正。単純合計はこの分だけ多くなる＝UIとのズレ要因）。重複している登録:`]));
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px;margin-top:var(--s-2)' });
    for (const p of rep.pairs) list.append(el('div', { class: 'qam-mono', style: 'font-size:var(--fs-sm);user-select:text' }, [`${p.a}  ∩  ${p.b}  （重複 ${p.overlap} 個）`]));
    if (rep.truncated) list.append(el('div', { class: 'qam-count' }, ['…（重複が多いため一部のみ表示）']));
    box.append(list);
  } else {
    box.append(el('div', { class: 'qam-lic-note' }, ['単体表記・レンジ表記の間に重複IPはありません。']));
  }
  return box;
}

// IPスコープ診断: asset/ip を「全モジュール / VM限定 / CertView / PC」で取得し、件数と
// 「全体にあって VM限定に無いIP」を表示して、UI(VM)との差分IPがどのスコープ由来かを特定する。
function buildIpScopeDiagBox(): HTMLElement {
  const box = el('div', { class: 'qam-lic-summary' });
  const btn = el('button', { class: 'btn btn--sm' }, ['IPスコープ診断（VM/CertView/PC別に取得して差分表示）']);
  const out = el('div', { style: 'margin-top:var(--s-2)' });
  const mono = (t: string): HTMLElement => el('div', { class: 'qam-mono', style: 'font-size:var(--fs-sm);user-select:text' }, [t]);
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', 'true'); clear(out); out.append(el('div', { class: 'qam-count' }, ['取得中…（4回 asset/ip を呼び出します）']));
    try {
      const cfg = await getConfig();
      const creds = { base: cfg.qualysBase, user: localStorage.getItem(LS.qualysUser) || cfg.qualysUser || '', pass: localStorage.getItem(LS.qualysPass) || '', proxy: cfg.proxy };
      if (!creds.base) { clear(out); toast('設定で Qualys 接続先(POD)を入力してください', 'error'); return; }
      if (!creds.user || !creds.pass) { const got = await promptQualysCreds(creds.user, creds.pass); if (!got) { clear(out); return; } creds.user = got.user; creds.pass = got.pass; }
      setRelayBusy(true);
      const rows = await diagnoseSubscriptionIps(creds);
      setRelayBusy(false);
      clear(out);
      const stat = (k: string, v: string): HTMLElement => el('div', { class: 'qam-lic-stat' }, [el('span', { class: 'qam-lic-stat-k' }, [k]), el('span', { class: 'qam-lic-stat-v' }, [v])]);
      for (const r of rows) out.append(stat(r.label, r.ok ? `一意 ${(r.unique ?? 0).toLocaleString()} / 単体 ${r.singles.length} / レンジ ${r.ranges.length}` : `取得失敗: ${r.error ?? ''}`));
      const all = rows.find((r) => r.key === 'all'); const vm = rows.find((r) => r.key === 'vm'); const cv = rows.find((r) => r.key === 'certview');
      if (all?.ok && vm?.ok) {
        const vmS = new Set(vm.singles); const vmR = new Set(vm.ranges); const cvS = new Set(cv?.singles ?? []); const cvR = new Set(cv?.ranges ?? []);
        const exS = all.singles.filter((s) => !vmS.has(s)); const exR = all.ranges.filter((s) => !vmR.has(s));
        out.append(el('div', { class: 'qam-lic-note', style: 'margin-top:var(--s-3)' }, [`全体にあって VM限定に無いIP（＝VMのAddress Managementに出ない差分。CertView/PC由来の可能性）: 単体 ${exS.length} 件 / レンジ ${exR.length} 件`]));
        if (!exS.length && !exR.length) out.append(el('div', { class: 'qam-count' }, ['差分なし（全体 = VM限定）。差分は別要因（Network 等）の可能性。']));
        for (const s of exS) out.append(mono(`${s}${cvS.has(s) ? '  ← CertViewにも在り' : ''}`));
        for (const s of exR) out.append(mono(`${s}${cvR.has(s) ? '  ← CertViewにも在り' : ''}（レンジ）`));
      }
    } catch (e) { clear(out); toast('IPスコープ診断に失敗: ' + (e as Error).message, 'error'); }
    finally { setRelayBusy(false); btn.removeAttribute('disabled'); }
  });
  box.append(btn, out);
  return box;
}

let licenseDefaulted = false; // ライセンス推移の初期表示（直近2年度）をセッション内で一度だけ適用

const emptyState = (t: string, d: string): HTMLElement => el('div', { class: 'qam-empty' }, [el('div', { class: 'qam-empty-title' }, [t]), el('div', {}, [d])]);

// 変更履歴のCSV/Excel: 各プロパティの「変更前」「変更後」をそれぞれ列に展開する。
// 共通列(更新日/変更種別/接続点ID/ID/変更項目) ＋ 出現した各項目について 〈項目〉(変更前)/(変更後) の2列。
function buildHistoryExport(events: QamEvent[], entity: QamEntity): ExportMatrix {
  const decoded = events.map((e) => ({ e, ...eventBeforeAfter(e) }));
  const keys: string[] = []; const seen = new Set<string>();
  for (const d of decoded) for (const k of [...d.before.keys(), ...d.after.keys()]) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const headers = ['更新日', '変更種別', '接続点ID', 'ID', '変更項目',
    ...keys.flatMap((k) => [`${histFieldLabel(entity, k)}(変更前)`, `${histFieldLabel(entity, k)}(変更後)`])];
  const rows = decoded.map(({ e, before, after }) => [
    fmtStamp(e.ts), changeLabelOf(e.change), eventSetten(entity, e), e.id, e.field ? histFieldLabel(entity, e.field) : '',
    ...keys.flatMap((k) => [before.get(k) ?? '', after.get(k) ?? '']),
  ]);
  return { headers, rows };
}

// 変更履歴の手動削除（選択した eid を history から除去）。
function histBulk(keys: string[]): HTMLElement[] {
  const b = el('button', { class: 'btn btn--sm btn--danger', html: `${icon('x', 14)}<span>選択した履歴を削除</span>` });
  b.addEventListener('click', async () => {
    if (!(await confirmModal('変更履歴の削除', `選択した ${keys.length} 件の変更履歴を削除します。よろしいですか？（元に戻せません）`, '削除'))) return;
    await ensureAuthor(); // 削除（更新作業）の直前に記入者名が未設定なら促す
    try { const n = await removeHistoryEvents(backend, state.entity, keys); recordOp('変更履歴削除', `${n}件`, state.entity); state.selected.clear(); toast(`変更履歴を ${n} 件削除しました`, 'ok'); refresh(); }
    catch (e) { toast('削除に失敗: ' + (e as Error).message, 'error'); }
  });
  return [b];
}

// ---- ingest ----
// 重複確認の方針を取込ラン内で共有（「すべて」取込で一件ごとに聞かず最初の1回だけ確認）。
interface DupPolicy { decided: boolean; proceed: boolean }
async function commitOne(snap: { entity: QamEntity; datetime: string; records: any }, raw?: string, dup?: DupPolicy, ipCount?: number | null, auto = false): Promise<void> {
  const cfg = await getConfig();
  // 取込日時 = XML の DATETIME 由来。重複チェック: 同 stamp=上書き / 同日=別取込として追加。
  const stamp = datetimeToStamp(snap.datetime);
  const existing = await getSnapshotStamps(backend, snap.entity);
  const sameStamp = existing.includes(stamp);
  const sameDay = !sameStamp && existing.some((s) => dateOfStamp(s) === dateOfStamp(stamp));
  if (sameStamp || sameDay) {
    let proceed: boolean;
    if (auto) {
      proceed = sameStamp; // 自動取込: 同 stamp は上書き、同日別追加はしない（無人で重複追加を避ける）
    } else if (dup?.decided) {
      proceed = dup.proceed; // ラン内で確認済み → 同じ判断を引き継ぐ（再確認しない）
    } else {
      proceed = sameStamp
        ? await confirmModal('既に取込済み（同じ取込日時）', `${fmtStamp(stamp)} は既に取り込まれています。上書きしますか？（このラン内の重複は以降確認しません）`)
        : await confirmModal('同じ日に取込済み', `${dateOfStamp(stamp)} に取込済みです。別の取込として追加しますか？（前のスナップショットは残ります。このラン内の重複は以降確認しません）`);
      if (dup) { dup.decided = true; dup.proceed = proceed; }
    }
    if (!proceed) { if (!auto) toast(`${snap.entity}: 取込を中止しました`, 'info'); return; }
  }
  const opts = { stamp, guardRatio: GUARD_RATIO, retentionDays: cfg.retentionDays || 90, rawXml: raw };
  let res = await ingestSnapshot(backend, snap as any, opts);
  if (res.guard && !res.committed) {
    if (auto) { recordOp('自動取込スキップ', `${snap.entity}: 件数急減ガード(${res.prevCount}→${res.currCount})`, snap.entity); return; }
    const ok = await confirmModal('件数が大きく減少しています', `${snap.entity}: ${res.prevCount} → ${res.currCount} 件。誤ったファイルでないか確認してください。取り込みますか？`);
    if (!ok) { toast(`${snap.entity}: 取り込みを中止しました`, 'info'); return; }
    res = await ingestSnapshot(backend, snap as any, { ...opts, force: true });
  }
  const sum = res.baseline ? '初回取込・基準確立' : `+${res.added}/~${res.modified}/-${res.deleted}`;
  if (!auto) toast(`${snap.entity} ${fmtStamp(res.stamp)}: ${res.currCount.toLocaleString()}件 (${sum})`, res.currCount === 0 ? 'info' : 'ok');
  recordOp(auto ? '自動取込' : '取込', `${fmtStamp(res.stamp)}: ${res.currCount.toLocaleString()}件 (${sum})`, snap.entity);
  // Host 取込ごとに、その時点の使用ライセンス数(登録IP数)を日時(stamp)つきで記録（推移グラフ用）。
  // host 取込ごとに Unique Hosts Scanned を記録。IPs in Subscription(ipCount)は API取得時のみ（XMLは null→0）。
  if (res.committed && snap.entity === 'host') await recordLicense(backend, res.stamp, ipCount ?? 0, uniqueHostsScanned(snap.records as QamRecords)).catch(() => undefined);
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

// Qualys ユーザ登録モーダル（/msp/user.php?action=add）。言語/SAML は API 非対応のため扱わない。
async function openUserAdd(): Promise<void> {
  const cfg = await getConfig();
  const field = (label: string, input: HTMLElement, hint?: string) =>
    el('div', { class: 'qam-field' }, [el('label', {}, [label]), input, ...(hint ? [callout(hint)] : [])]);
  const name = el('input', { class: 'in', placeholder: '例: 山田　太郎（全角スペース区切り）' }) as HTMLInputElement;
  const company = el('input', { class: 'in', placeholder: '会社名' }) as HTMLInputElement;
  const email = el('input', { class: 'in', type: 'email', placeholder: 'name@example.com' }) as HTMLInputElement;
  const scan = el('select', { class: 'in' }) as HTMLSelectElement;
  ([['static', '静的'], ['dynamic', '動的']] as [ScanType, string][]).forEach(([v, t]) => scan.append(el('option', { value: v }, [t])));
  const role = el('select', { class: 'in' }) as HTMLSelectElement;
  ([['scanner', 'Scanner'], ['reader', 'Reader']] as [UserRole, string][]).forEach(([v, t]) => role.append(el('option', { value: v }, [t])));
  const setten = el('input', { class: 'in', placeholder: '接続点ID（所属AssetGroupの先頭トークン）' }) as HTMLInputElement;
  // 動的は権限 Reader 固定。
  const syncRole = (): void => { const dyn = scan.value === 'dynamic'; if (dyn) role.value = 'reader'; role.disabled = dyn; };
  scan.addEventListener('change', syncRole); syncRole();

  const body = el('div', {}, [
    field('氏名（姓 名・全角スペース区切り）', name, '英字が全角でも半角に変換して登録します（姓→Last name、名→First name）。'),
    field('会社名', company, 'Qualys には送信せず、操作ログに記録します。'),
    field('メールアドレス', email),
    field('検査対象区分', scan, '動的は権限が Reader 固定になります。'),
    field('権限', role),
    field('接続点ID', setten, '最新の AssetGroup から、この接続点IDで始まるグループに所属させます（asset_groups）。'),
    callout('言語と SAML は Qualys API では設定できません。SAML は「新規ユーザに SSO 有効化」をサブスクリプション側で設定してください。登録メール（パスワード設定案内）は送りません。'),
  ]);

  openModal({
    title: 'Qualys ユーザ登録', body, primaryLabel: '登録',
    onPrimary: async () => {
      const fullName = name.value.trim();
      if (!fullName || !/[ 　]/.test(fullName)) { toast('氏名を「姓 名」（全角スペース区切り）で入力してください', 'error'); return false; }
      if (!email.value.trim()) { toast('メールアドレスを入力してください', 'error'); return false; }
      const sid = setten.value.trim();
      if (!sid) { toast('接続点IDを入力してください', 'error'); return false; }
      if (!(cfg.userCountry || '').trim()) { toast('共通設定の「ユーザ登録: 国」を設定してください', 'error'); return false; }
      // 接続点ID → 最新 group スナップショットの AssetGroup タイトルを解決。
      const gStamp = resolveAsof(await getSnapshotStamps(backend, 'group'));
      const gSnap = gStamp ? await readSnapshot(backend, 'group', gStamp) : null;
      const assetGroups = (Object.values(gSnap?.records ?? {}) as QamRecord[])
        .map((g) => g.name).filter((t) => settenId(t) === sid);
      if (!assetGroups.length) { toast(`接続点ID「${sid}」に一致する AssetGroup が見つかりません（group を取込済みか確認してください）`, 'error'); return false; }
      // 認証情報（個人設定・ブラウザ保持。未設定ならその場で促す）。
      const creds = { base: cfg.qualysBase, user: localStorage.getItem(LS.qualysUser) || cfg.qualysUser || '', pass: localStorage.getItem(LS.qualysPass) || '', proxy: cfg.proxy };
      if (!creds.base) { toast('設定で Qualys 接続先(POD)を入力してください', 'error'); return false; }
      if (!creds.user || !creds.pass) { const got = await promptQualysCreds(creds.user, creds.pass); if (!got) return false; creds.user = got.user; creds.pass = got.pass; }
      const scanType = scan.value as ScanType;
      const picked = role.value as UserRole;
      const finalRole = scanType === 'dynamic' ? 'Reader（動的固定）' : picked;
      if (!(await confirmModal('Qualys ユーザ登録', `${fullName}（${email.value.trim()}）を 権限「${finalRole}」・所属「${assetGroups.join(', ')}」で Qualys に登録します。よろしいですか？`, '登録'))) return false;
      await ensureAuthor();
      try {
        setRelayBusy(true);
        const { login } = await addQualysUser(creds, {
          fullName, email: email.value, scanType, role: picked, assetGroups,
          businessUnit: cfg.userBusinessUnit || 'Unassigned', country: cfg.userCountry,
        });
        const co = company.value.trim();
        recordOp('Qualysユーザ登録', `${fullName} / ${email.value.trim()}${co ? ' / ' + co : ''} / ${scanType === 'dynamic' ? 'reader(動的)' : picked} / 接続点ID:${sid}${login ? ' / login:' + login : ''}`, 'user');
        toast(`ユーザを登録しました${login ? '（' + login + '）' : ''}`, 'ok');
        return true;
      } catch (e) { toast('登録に失敗: ' + (e as Error).message, 'error'); return false; }
      finally { setRelayBusy(false); }
    },
  });
}

function openIngest(): void {
  const panel = el('div', {});
  const body = el('div', {});
  const seg = el('div', { class: 'qam-chip-row', style: 'margin-bottom:var(--s-5)' });
  const apiBtn = el('button', { class: 'btn btn--sm' }, ['API ダウンロード']);
  const xmlBtn = el('button', { class: 'btn btn--sm' }, ['XML アップロード']);
  const histBtn = el('button', { class: 'btn btn--sm' }, ['変更履歴CSV']);
  const valBtn = el('button', { class: 'btn btn--sm' }, ['値CSV(AssetGroup)']);
  const prog = el('div', { class: 'qam-progress', style: 'display:none' });
  seg.append(apiBtn, xmlBtn, histBtn, valBtn); body.append(seg, panel, prog);

  const labelOf = (k: QamEntity): string => ENTITIES.find((e) => e.key === k)?.label ?? k;
  function setProg(msg: string, busy: boolean): void {
    clear(prog); prog.style.display = 'flex';
    prog.append(busy ? el('span', { class: 'qam-spin' }) : el('span', { html: icon('check', 16) }), el('span', { class: 'qam-prog-msg' }, [msg]));
  }

  function showApi(): void {
    apiBtn.className = 'btn btn--sm btn--primary'; xmlBtn.className = 'btn btn--sm'; histBtn.className = 'btn btn--sm'; valBtn.className = 'btn btn--sm';
    clear(panel);
    const sel = el('select', { class: 'in' }) as HTMLSelectElement;
    sel.append(el('option', { value: 'all' }, ['すべて']));
    ENTITIES.forEach((e) => sel.append(el('option', { value: e.key }, [e.label])));
    const go = el('button', { class: 'btn btn--primary', html: `${icon('download', 16)}<span>ダウンロードして取込</span>` });
    go.addEventListener('click', async () => {
      await ensureAuthor(); // 取込（更新作業）の直前に記入者名が未設定なら促す
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
        // host を取り込むなら IPs in Subscription（登録IP総数）も取得（best-effort）。
        // 件数照合の検証用に、応答XMLを raw/<日付>/ips-<stamp>.xml にも残す。
        let ipCount: number | null = null;
        if (kinds.includes('host')) {
          setProg('IPs in Subscription を取得中…', true);
          const ipRes = await downloadIps(creds);
          ipCount = ipRes.count;
          if (ipRes.xml) { try { await backend.write(`raw/${today}/ips-${stampNow()}.xml`, ipRes.xml); } catch { /* XML保存失敗は本処理に影響させない */ } }
        }
        for (const k of kinds) {
          setProg(`${labelOf(k)}: ダウンロード中…`, true);
          const dl = await downloadEntity(k, creds, (p) => setProg(`${labelOf(k)}: ${p.page} ページ目・${p.records.toLocaleString()} 件取得…`, true));
          setProg(`${labelOf(k)}: 差分計算・保存中…（${Object.keys(dl.snapshot.records).length.toLocaleString()} 件）`, true);
          await commitOne(dl.snapshot, dl.raw, dup, ipCount);
        }
        setProg('完了しました', false);
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { setRelayBusy(false); go.removeAttribute('disabled'); sel.removeAttribute('disabled'); }
    });
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['取得対象']), sel]), go);
  }
  function showXml(): void {
    xmlBtn.className = 'btn btn--sm btn--primary'; apiBtn.className = 'btn btn--sm'; histBtn.className = 'btn btn--sm'; valBtn.className = 'btn btn--sm';
    clear(panel);
    const file = el('input', { type: 'file', accept: '.xml', class: 'in' }) as HTMLInputElement;
    const go = el('button', { class: 'btn btn--primary', html: `${icon('upload', 16)}<span>取込</span>` });
    go.addEventListener('click', async () => {
      if (!file.files?.length) { toast('XML ファイルを選択してください', 'error'); return; }
      await ensureAuthor(); // 取込（更新作業）の直前に記入者名が未設定なら促す
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
    histBtn.className = 'btn btn--sm btn--primary'; apiBtn.className = 'btn btn--sm'; xmlBtn.className = 'btn btn--sm'; valBtn.className = 'btn btn--sm';
    clear(panel);
    const sel = el('select', { class: 'in' }) as HTMLSelectElement;
    ENTITIES.forEach((e) => sel.append(el('option', { value: e.key, selected: e.key === 'group' }, [e.label])));
    const file = el('input', { type: 'file', accept: '.csv', class: 'in' }) as HTMLInputElement;
    const go = el('button', { class: 'btn btn--primary', html: `${icon('inbox', 16)}<span>履歴を取込</span>` });
    go.addEventListener('click', async () => {
      if (!file.files?.length) { toast('CSV ファイルを選択してください', 'error'); return; }
      const entity = sel.value as QamEntity;
      await ensureAuthor(); // 取込（更新作業）の直前に記入者名が未設定なら促す
      go.setAttribute('disabled', 'true');
      setRelayBusy(true); // 取込中は死活ポーリングを止める（連続書き込みで誤検知しないように）
      try {
        setProg('CSV を解析中…', true);
        const resolveId = await buildIdResolver(entity); // 名前→Qualys ID（接続点IDは ID にしない）
        const stats = { skipped: 0 }; // 更新日/識別名が無くスキップした行
        const events = parseHistoryCsv(entity, await file.files[0].text(), resolveId, stats);
        setProg(`解析完了（${events.length.toLocaleString()} 行）。取込を開始します…`, true);
        const n = await importHistory(backend, entity, events, (done, total) => setProg(`変更履歴を取込中… ${done.toLocaleString()} / ${total.toLocaleString()} 件`, true));
        const skipMsg = stats.skipped ? ` / ${stats.skipped.toLocaleString()} 行は更新日/識別名なしでスキップ` : '';
        setProg(`完了しました（${n.toLocaleString()} 件追加 / ${(events.length - n).toLocaleString()} 件は重複でスキップ${skipMsg}）`, false);
        toast(`変更履歴を ${n.toLocaleString()} 件取り込みました`, 'ok');
        recordOp('変更履歴CSV取込', `${n.toLocaleString()}件追加`, entity);
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { setRelayBusy(false); go.removeAttribute('disabled'); }
    });
    const hint = el('div', { class: 'qam-count', style: 'margin-top:var(--s-3);user-select:text' });
    const setHint = (): void => { clear(hint); hint.append(`CSVヘッダ: ${HIST_HEADER_HINT[sel.value as QamEntity]}`); };
    sel.addEventListener('change', setHint); setHint();
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['対象（種別ごとに個別取込）']), sel]), el('div', { class: 'qam-field' }, [el('label', {}, ['変更履歴 CSV']), file]), hint, go);
  }
  // AssetGroup の手動値を CSV で一括取込（接続点IDをキーに上書き。列名は一覧の列名と同じ）。
  function showAssetValues(): void {
    valBtn.className = 'btn btn--sm btn--primary'; apiBtn.className = 'btn btn--sm'; xmlBtn.className = 'btn btn--sm'; histBtn.className = 'btn btn--sm';
    clear(panel);
    const file = el('input', { type: 'file', accept: '.csv', class: 'in' }) as HTMLInputElement;
    const go = el('button', { class: 'btn btn--primary', html: `${icon('inbox', 16)}<span>値を取込（上書き）</span>` });
    go.addEventListener('click', async () => {
      if (!file.files?.length) { toast('CSV ファイルを選択してください', 'error'); return; }
      await ensureAuthor(); // 取込（更新作業）の直前に記入者名が未設定なら促す
      go.setAttribute('disabled', 'true');
      setRelayBusy(true); // 取込中は死活ポーリングを止める（1行ごとに書き込むため）
      try {
        setProg('CSV を解析中…', true);
        const res = await importAssetValues(await file.files[0].text(), (done, total, phase) =>
          setProg(phase === 'save' ? `${total.toLocaleString()} 件を保存中…` : `CSV を照合中… ${done.toLocaleString()} / ${total.toLocaleString()} 行`, true));
        setProg(`完了しました（${res.updated.toLocaleString()} 件更新 / 未マッチ ${res.unmatched.toLocaleString()} 件）`, false);
        toast(`AssetGroup の値を ${res.updated.toLocaleString()} 件取り込みました`, 'ok');
        recordOp('値CSV取込', `${res.updated.toLocaleString()}件更新(${res.fields.join('/')})`, 'group');
        refresh();
      } catch (e) { setProg('失敗: ' + (e as Error).message, false); toast('取込に失敗しました: ' + (e as Error).message, 'error'); }
      finally { setRelayBusy(false); go.removeAttribute('disabled'); }
    });
    const hint = callout('CSVヘッダは一覧の列名と同じに。接続点ID をキーに、外接番号/事業場名(Division)/接続名称(Function)/拠点名称(Location)/コメント(Comments) を上書き取込します（空欄はクリア）。先に AssetGroup を取込済みであること（接続点ID→AssetGroupの突き合わせに使用）。');
    panel.append(el('div', { class: 'qam-field' }, [el('label', {}, ['AssetGroup 値 CSV']), file]), hint, go);
  }
  apiBtn.addEventListener('click', showApi); xmlBtn.addEventListener('click', showXml); histBtn.addEventListener('click', showHist); valBtn.addEventListener('click', showAssetValues);
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
  const licLimit = el('input', { class: 'in', type: 'number', min: '0', value: String(cfg.licenseLimit || 0) }) as HTMLInputElement;
  const bkInterval = el('input', { class: 'in', type: 'number', min: '0', value: String(cfg.backupIntervalMin ?? 60) }) as HTMLInputElement;
  const bkRetention = el('input', { class: 'in', type: 'number', min: '1', value: String(cfg.backupRetentionDays ?? 7) }) as HTMLInputElement;
  const userBu = el('input', { class: 'in', value: cfg.userBusinessUnit || 'Unassigned', placeholder: 'Unassigned' }) as HTMLInputElement;
  const userCountry = el('input', { class: 'in', value: cfg.userCountry || '', placeholder: '例: Japan' }) as HTMLInputElement;
  const fiscalMonth = el('input', { class: 'in', type: 'number', min: '1', max: '12', value: String(cfg.fiscalStartMonth || 4) }) as HTMLInputElement;
  const inspPattern = el('input', { class: 'in', value: cfg.inspectionAgPattern || DEFAULT_AG_PATTERN, placeholder: DEFAULT_AG_PATTERN }) as HTMLInputElement;
  const scanOpt = el('input', { class: 'in', value: cfg.scanOptionProfile || '', placeholder: '未設定ならアカウント既定' }) as HTMLInputElement;
  const mapOpt = el('input', { class: 'in', value: cfg.mapOptionProfile || '', placeholder: '未設定ならアカウント既定' }) as HTMLInputElement;
  const scannerAp = el('input', { class: 'in', value: cfg.scannerAppliance || 'External', placeholder: 'External' }) as HTMLInputElement;
  const schedTz = el('input', { class: 'in', value: cfg.scheduleTimeZone || 'JP', placeholder: 'JP' }) as HTMLInputElement;
  const regionsIn = el('input', { class: 'in', value: cfg.regions || formatRegions(DEFAULT_REGIONS), placeholder: formatRegions(DEFAULT_REGIONS) }) as HTMLInputElement;
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

  // 共通設定: バックアップからの復元（メモ・注釈・変更履歴・ライセンス推移を退避時点へ戻す）。
  const bkSelect = el('select', { class: 'in' }) as HTMLSelectElement;
  const fillBackups = async (selectSlot?: string) => {
    clear(bkSelect);
    const list = await listBackups(backend);
    if (list.length) list.forEach((s) => bkSelect.append(el('option', { value: s, selected: s === selectSlot }, [fmtStamp(s)])));
    else bkSelect.append(el('option', { value: '' }, ['(バックアップなし)']));
  };
  await fillBackups();
  // 今すぐバックアップ（動作確認用）: 自動取得を待たず手動で1回退避し、結果を表示する。
  const bkNowBtn = el('button', { class: 'btn btn--sm' }, ['今すぐバックアップ']);
  bkNowBtn.addEventListener('click', async () => {
    bkNowBtn.setAttribute('disabled', 'true');
    try {
      const interval = Math.max(0, parseInt(bkInterval.value, 10) || 0) || 60;
      const slot = backupSlot(new Date(), interval);
      const res = await backupNow(slot);
      if (!res.ok) throw new Error(res.error || 'バックアップに失敗しました');
      await fillBackups(slot);
      toast(`バックアップしました（${res.files ?? 0}ファイル / ${fmtStamp(slot)}）`, 'ok');
    } catch (e) { toast('バックアップに失敗: ' + (e as Error).message, 'error'); }
    finally { bkNowBtn.removeAttribute('disabled'); }
  });
  const bkRestoreBtn = el('button', { class: 'btn btn--sm' }, ['選択したバックアップから復元']);
  bkRestoreBtn.addEventListener('click', async () => {
    const slot = bkSelect.value;
    if (!slot) { toast('復元するバックアップを選択してください', 'error'); return; }
    if (!(await confirmModal('バックアップから復元', `${fmtStamp(slot)} 時点の状態に戻します（全データ＝資産スナップショット・変更履歴・メモ・注釈・ライセンス推移）。この時点以降に追加したメモ・取込なども取り除かれ、退避時点と同じ状態になります。よろしいですか？`, '復元'))) return;
    try { const res = await restoreNow(slot); if (!res.ok) throw new Error(res.error || '復元に失敗しました'); toast(`復元しました（${res.files ?? 0}ファイル）`, 'ok'); refresh(); }
    catch (e) { toast('復元に失敗: ' + (e as Error).message, 'error'); }
  });
  const bkRestoreBox = el('div', {}, [bkSelect, el('div', { style: 'margin-top:var(--s-3)' }, [bkRestoreBtn])]);

  const cats: { id: string; label: string; pane: () => HTMLElement[] }[] = [
    { id: 'personal', label: '個人設定', pane: () => [field('記入者名（メモ・操作履歴の作成者）', author), field('テーマ', theme), field('文字サイズ', fontsize), field('Qualys アカウント', user), field('Qualys パスワード（このブラウザに保存）', pass, 'Qualys API 認証用。共有 env ではなくこのブラウザにのみ保存します。')] },
    { id: 'common', label: '共通設定', pane: () => [field('Qualys 接続先 POD', base), field('プロキシ URL', proxy), field('保存期間（日）', ret), field('ライセンス上限', licLimit, '契約のライセンス上限。推移グラフに破線（基準線）として表示し、残数算出に使います。IPs in Subscription（登録IP数）とは別。0 で非表示。'), field('自動バックアップ間隔（分）', bkInterval, 'ツール起動時に、この間隔ごとに1回だけ全データ（資産スナップショット・変更履歴・メモ・注釈・ライセンス推移）を zip で自動退避します（生XML・ログ・接続設定は除く。その時間に誰も起動しなければ作成されません）。0 で無効。既定60。'), field('バックアップ保管（日）', bkRetention, 'この日数を過ぎたバックアップは自動削除。既定7。'), field('今すぐバックアップ（動作確認）', bkNowBtn, '自動取得を待たず、現在の全データを手動で退避します。'), field('バックアップから復元', bkRestoreBox, '選択した時点の状態に戻します（その時点以降に追加したメモ・取込なども取り除かれます）。'), field('ユーザ登録: business_unit', userBu, 'Qualys ユーザ登録時の business_unit（既定 Unassigned）。'), field('ユーザ登録: 国（country）', userCountry, 'Qualys ユーザ登録の必須項目。Qualys が受け付ける国名を入力（例: Japan）。'), field('四半期検査: 年度開始月', fiscalMonth, '四半期の区切り。4 なら Q1=4-6 / Q2=7-9 / Q3=10-12 / Q4=1-3（年度）。1 で暦年四半期。既定 4。'), field('四半期検査: 対象の接続点ID パターン', inspPattern, `四半期検査の対象にする接続点ID の正規表現（大文字小文字は無視）。接続点ID は AssetGroup タイトルの先頭〜最初の半角スペース（資産一覧の「接続点ID」列と同じ）。既定 ${DEFAULT_AG_PATTERN} は「英字2文字＋数字3〜4桁＋末尾D(任意)」。`), field('検査登録: SCAN のオプションプロファイル', scanOpt, 'SCAN のスケジュール登録時に既定で入るオプションプロファイル名。登録画面で変更できます。'), field('検査登録: MAP のオプションプロファイル', mapOpt, 'MAP のスケジュール登録時に既定で入るオプションプロファイル名。登録画面で変更できます。'), field('検査登録: スキャナー', scannerAp, 'スケジュール登録時に既定で入るスキャナー名。既定 External。'), field('検査登録: タイムゾーン', schedTz, 'スケジュール登録時に既定で入るタイムゾーンコード（大文字）。既定 JP。'), field('検査登録: 地域区分', regionsIn, '「ラベル=コード」のカンマ区切り。コードはドメイン名の末尾に付きます（例 ext-2026-001.jp）。空にすると既定の6区分に戻ります。')] },
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
        await setConfig({ qualysBase: base.value.trim(), proxy: proxy.value.trim(), retentionDays: parseInt(ret.value, 10) || 90, licenseLimit: Math.max(0, parseInt(licLimit.value, 10) || 0), backupIntervalMin: Math.max(0, parseInt(bkInterval.value, 10) || 0), backupRetentionDays: Math.max(1, parseInt(bkRetention.value, 10) || 7), userBusinessUnit: userBu.value.trim() || 'Unassigned', userCountry: userCountry.value.trim(), fiscalStartMonth: Math.min(12, Math.max(1, parseInt(fiscalMonth.value, 10) || 4)), inspectionAgPattern: inspPattern.value.trim() || DEFAULT_AG_PATTERN, scanOptionProfile: scanOpt.value.trim(), mapOptionProfile: mapOpt.value.trim(), scannerAppliance: scannerAp.value.trim() || 'External', scheduleTimeZone: schedTz.value.trim().toUpperCase() || 'JP', regions: formatRegions(parseRegions(regionsIn.value)) });
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

// ヘルプ（使い方マニュアル）モーダル。
function openHelp(): void {
  const body = el('div', { class: 'qam-help', html: `
    <h3>QAM とは</h3>
    <p>Qualys の AssetGroup / Host / Domain / User の改廃（追加・変更・削除）履歴を記録し、任意時点の資産一覧・変更履歴・ライセンス推移を確認するツールです。各自のPCでローカル中継(relay)が動き、ブラウザで操作します。</p>

    <h3>起動</h3>
    <ul>
      <li><b>qam-start.bat</b> をダブルクリック → relay が起動し、既定ブラウザで自動的に開きます。</li>
      <li>「中継サーバに接続できません」が出たら、relay（別ウィンドウ）が起動しているか確認し「再接続」を押します。</li>
    </ul>

    <h3>最初の設定（右上の ⚙ 設定）</h3>
    <ul>
      <li><b>個人設定</b>：記入者名（操作履歴・メモの作業者）、Qualys アカウント／パスワード、テーマ、文字サイズ。</li>
      <li><b>共通設定</b>：Qualys 接続先 POD、プロキシ URL、保存期間（日）、ライセンス上限、四半期検査の年度開始月・対象の接続点ID パターン、検査登録の既定値（SCAN／MAP のオプションプロファイル・スキャナー・タイムゾーン）。</li>
      <li><b>開発者</b>：データのリセット（資産/履歴/メモを種類選択）、登録情報のリセット、ビルド情報。</li>
    </ul>
    <p>※ Qualys 認証情報・記入者名は各自のブラウザに保存され共有されません。更新作業の直前に記入者名が未設定なら入力を促します。</p>

    <h3>データの取込（右上の 取込）</h3>
    <ul>
      <li><b>API ダウンロード</b>：種別（すべて／個別）を選んで Qualys から取得。Host 取込時は IPs in Subscription も自動取得。</li>
      <li><b>XML アップロード</b>：Qualys の一覧 XML を読み込み（種別は自動判定）。</li>
      <li><b>変更履歴CSV</b>：手運用の改廃履歴CSVを取り込み（種別ごと）。ヘッダ名で列を対応付けます。</li>
      <li><b>値CSV(AssetGroup)</b>：接続点IDをキーに 事業場名／接続名称／拠点名称／コメント／外接番号 を上書き。</li>
    </ul>
    <p>取込は「取込日時」ごとに保存します。同じ日時＝上書き、別時刻＝別取込として追加。件数が急減した場合は確定前に確認します。</p>

    <h3>資産一覧</h3>
    <ul>
      <li>上部タブで種別、「基準（取込日時）」で時点を選択。</li>
      <li>検索（ID／名前／IP／FQDN、IP はレンジ内判定も）。× でクリア。</li>
      <li>列名クリックで Excel 風オートフィルタ（並べ替え＋値で絞り込み）。じょうごアイコンが絞り込み中の目印。Esc で閉じる。</li>
      <li>「列表示」で列の表示／非表示。列はドラッグで並べ替え、境界ドラッグで幅変更。</li>
      <li>事業場名／接続名称／拠点名称／コメント／外接番号 はセルをクリックして手入力（自動保存）。</li>
      <li>CSV／Excel／全資産Excel で出力できます。</li>
    </ul>

    <h3>変更履歴</h3>
    <ul>
      <li>左のカレンダーで変更日を確認（クリックで当日、ドラッグ／Shift＋クリックで範囲）。期間・種別でも絞り込み。</li>
      <li>更新日は Qualys 上の更新時刻（AssetGroup は LAST_UPDATE）。表示は JST。</li>
      <li><b>行をクリック</b>すると、追加／削除／変更した資産の情報（プロパティ）を表示します。</li>
      <li>追加IP／削除IP・追加DNS／削除DNS・追加FQDN／削除FQDN 列で増減を確認できます。</li>
      <li>不要な履歴は選択して削除できます。</li>
    </ul>

    <h3>四半期検査</h3>
    <ul>
      <li>「四半期に一度は SCAN / MAP 検査を実施する」ルールに対して、<b>現四半期の充足状況</b>を確認します。</li>
      <li>対象は AssetGroup タイトルから切り出した<b>接続点ID</b>（タイトル先頭〜最初の半角スペース）が
          <b>対象パターン</b>（共通設定）に一致するもの。<b>一覧も接続点ID 単位</b>で出ます。SCAN は接続点単位、
          <b>MAP はその接続点に登録されたドメイン単位</b>で判定します。<b>ドメイン未登録の接続点は MAP 対象外</b>です。</li>
      <li>接続点ID が <b>D で終わらず、かつ IP が未登録</b>の AssetGroup は、スキャンする実体が無いので
          <b>SCAN 対象外</b>です（D 終わりは動的運用で IP を登録しないため対象のまま）。この条件で外れても、
          ドメイン登録があれば MAP の対象には残ります。対象外になったものは「対象母集団」に理由付きで出ます。</li>
      <li>四半期内に完了実施あり＝<b>検査済み</b>／実施は無いが四半期内に実行予定あり＝<b>スケジュール済み</b>／
          どちらも無い＝<b>未対応</b>。</li>
      <li><b>未対応の AssetGroup</b>、<b>週次サマリ</b>（その週の実施件数と累計カバレッジ）、
          <b>対象×週マトリクス</b>（どの週に検査されたか）を表示します。</li>
      <li>「Qualys から取得」で最新状況を取得（母集団の AssetGroup は資産取込のものを使うため再取得不要）。
          CSV／Excel で出力できます。</li>
      <li><b>新規検査登録</b>：<b>AssetGroup とドメインを払い出してから、検査スケジュールを登録</b>します
          （作成のみ。変更・削除は Qualys の画面で行ってください）。
          AssetGroup 名は<b>「申請番号(仮)」</b>、ドメイン名は<b>「小文字の申請番号.地域コード」</b>になります
          （(仮) はDNS名に使えないためドメインでは省きます）。
          検査種別は <b>SCAN のみ／MAP のみ／両方</b>から選べます。
          SCAN 対象の IP は行ごとに<b>「単体（IP・CIDR）」と「レンジ（開始〜終了）」を切り替え</b>られ、
          IP・DNS とも複数行を指定できます。入力内容から作られる AssetGroup 名・ドメイン名はその場に表示されます。
          <b>同名が既にある場合は「既存を使う／別名で作る／中止」を確認</b>します。
          登録内容は操作履歴に残り、<b>実行者・発行したAPI・パラメータは api-audit.log にも記録</b>されます。</li>
      <li><b>検査一覧</b>：取得した<b>実行履歴</b>と<b>予約済み</b>を1つの表で確認できます。「区分」列で
          どちらかに絞り込めます。</li>
      <li>取得結果は<b>取込日ごとに保存</b>されます（同じ日に取り直すと上書き）。ツールバーの
          <b>「取込日」</b>で過去の時点の状況を後から確認できます。そのときの AssetGroup 登録状況に
          合わせて判定されます。保存期間を過ぎたものは資産スナップショットと同様に自動削除されます。</li>
    </ul>

    <h3>ライセンス数推移</h3>
    <ul>
      <li>折れ線＝<b>Unique Hosts Scanned</b>（スキャン済み一意ホスト数。host 一覧から算出）。</li>
      <li><b>IPs in Subscription</b>（登録IP総数）＝ API 取込時に Qualys から自動取得。</li>
      <li>破線＝<b>ライセンス上限</b>（設定値）。年度（4月〜翌3月）ごとに重ね表示し、凡例で年度の表示を切替。</li>
    </ul>

    <h3>操作履歴</h3>
    <p>取込・編集・削除などの操作を、作業者と日時（JST）つきで記録します。</p>

    <h3>注意</h3>
    <ul>
      <li>ファイルサーバ配置で複数人が使う場合、<b>同時の更新は不可</b>（取込・編集は1人ずつ）。閲覧の同時利用は可能です。</li>
      <li>保存期間を過ぎると資産スナップショットは剪定されますが、<b>変更履歴・メモ・操作履歴・ライセンス推移は恒久保持</b>です。</li>
    </ul>
    <div class="qam-help-foot">build ${BUILD}${BUILDTIME ? `（${BUILDTIME}）` : ''}</div>
  ` });
  openModal({ title: 'ヘルプ（使い方）', body });
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
// 記入者名が未設定なら入力モーダルを出す（更新作業の直前に呼ぶ）。設定済みなら即解決。
// 閉じる/キャンセルされても解決する＝作業はブロックしない（未設定のままなら次回の更新時にまた促す）。
function ensureAuthor(): Promise<void> {
  if (localStorage.getItem(LS.author)) return Promise.resolve();
  return new Promise((resolve) => {
    const inp = el('input', { class: 'in', placeholder: '例: 山田' }) as HTMLInputElement;
    onEnter(inp, () => { const v = inp.value.trim(); if (v) { localStorage.setItem(LS.author, v); } });
    const body = el('div', {}, [el('div', { class: 'qam-field' }, [
      el('label', {}, ['記入者名']),
      inp,
      callout('この更新の「作業者」として操作履歴・メモに記録されます。設定でいつでも変更できます。'),
    ])]);
    openModal({
      title: '記入者名の入力', body, primaryLabel: '保存',
      onPrimary: () => { const v = inp.value.trim(); if (!v) { toast('記入者名を入力してください', 'error'); return false; } localStorage.setItem(LS.author, v); resolve(); return true; },
      onClose: () => resolve(),
    });
  });
}

// 自動バックアップ（データディレクトリ全体を zip 退避）。ツール起動時に実行を試みる:
//   ・slot = 保存間隔で丸めた時刻。同 slot のバックアップが既にあればスキップ（＝1時間に1回）。
//   ・ランダムなジッタ後に再確認して未取得なら作成 → 同時起動でも実質「ランダムな1名」だけが取得。
//   ・誰もツールを上げていない時間帯は作成されない（起動時のみ実行のため自然にスキップ）。
//   ・期限切れ（保管日数超過）は自動削除。失敗・作業ログ出力はしない（本処理を止めない）。
async function maybeBackup(): Promise<void> {
  try {
    const cfg = await getConfig();
    const interval = cfg.backupIntervalMin ?? 60;
    const retention = cfg.backupRetentionDays ?? 7;
    if (interval <= 0) return; // 0 で無効
    const slot = backupSlot(new Date(), interval);
    if (await hasBackup(backend, slot)) { await pruneBackups(backend, retention, today()); return; }
    // ランダムジッタ（0〜5秒）で同時起動の競合を散らし、再確認して未取得の1名だけが作成する。
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5000)));
    if (await hasBackup(backend, slot)) return;
    const res = await backupNow(slot);
    if (res.ok) await pruneBackups(backend, retention, today());
  } catch { /* バックアップ失敗は本処理に影響させない */ }
}

// 無人取込（Edge ヘッドレス等から ?autoingest=<種別CSV> で起動）。確認ダイアログは出さない。
// 当日スナップショットが既にある種別はスキップ。認証情報はこのブラウザプロファイルの localStorage を使う。
async function runAutoIngest(kinds: QamEntity[]): Promise<void> {
  recordOp('自動取込開始', kinds.join(','));
  try {
    const cfg = await getConfig();
    const creds = { base: cfg.qualysBase, user: localStorage.getItem(LS.qualysUser) || cfg.qualysUser || '', pass: localStorage.getItem(LS.qualysPass) || '', proxy: cfg.proxy };
    if (!creds.base || !creds.user || !creds.pass) { recordOp('自動取込中止', '接続先/認証情報が未設定（このプロファイルに保存が必要）'); return; }
    const today = dateOfStamp(stampNow());
    const todayDone = async (k: QamEntity): Promise<boolean> => (await getSnapshotStamps(backend, k)).some((s) => dateOfStamp(s) === today);
    const pending: QamEntity[] = [];
    for (const k of kinds) { if (!(await todayDone(k))) pending.push(k); }
    if (!pending.length) { recordOp('自動取込スキップ', '本日分は取込済み'); return; }
    setRelayBusy(true);
    let ipCount: number | null = null;
    if (pending.includes('host')) {
      const r = await downloadIps(creds); ipCount = r.count;
      if (r.xml) await backend.write(`raw/${today}/ips-${stampNow()}.xml`, r.xml).catch(() => undefined);
    }
    for (const k of pending) {
      const dl = await downloadEntity(k, creds);
      await commitOne(dl.snapshot, dl.raw, undefined, ipCount, true); // auto=true（非対話）
    }
    recordOp('自動取込完了', pending.join(','));
  } catch (e) { recordOp('自動取込エラー', (e as Error).message); }
  finally { setRelayBusy(false); }
}

async function start(): Promise<void> {
  startRelayPolling(); // 30秒間隔で中継サーバを死活監視（落ちたら警告・復帰で自動クローズ）
  if (!(await checkRelay())) { showRelayDownModal(); return; }
  // 起動時に記入者名を強制入力させない。更新作業（取込/メモ・注釈の記載/削除）の直前に未設定なら促す。
  refresh();
  const ai = new URLSearchParams(location.search).get('autoingest');
  if (ai !== null) {
    // 無人モード: バックアップ→取込 の順に実行し、終わったらウィンドウを閉じる（ヘッドレス用）。
    const kinds = (ai || 'host,group,domain,user').split(',').map((s) => s.trim()).filter(Boolean) as QamEntity[];
    void (async () => { await maybeBackup(); await runAutoIngest(kinds); try { window.close(); } catch { /* 通常ブラウザでは閉じない */ } })();
  } else {
    void maybeBackup(); // 起動時バックアップ（バックグラウンドで実行。UI はブロックしない）
  }
}
start();
