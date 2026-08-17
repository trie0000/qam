// relay クライアント: relay の各エンドポイントの薄いラッパ。
import { RELAY } from './config';
import type { FileBackend } from './store';

async function postJson(path: string, body: unknown): Promise<any> {
  const r = await fetch(RELAY + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// 保管先は SharePoint ライブラリ。起動時に initStorage が setBackend で差し込む。
// 呼び出し側は `backend` を import したままでよいよう、差し替え可能な委譲にしておく。
// ★既定は「未初期化なら例外」。ここを黙って動く実装にすると、保管先への接続に失敗した
//   ときに気づかないまま別の場所へ書き、「自分だけ違うものを見ている」事故になる。
const notReady = (): never => { throw new Error('保管先が未初期化です（SharePoint への接続に失敗しています）'); };
let impl: FileBackend = { read: notReady, write: notReady, list: notReady, remove: notReady };
export const setBackend = (b: FileBackend): void => { impl = b; };
export const backend: FileBackend = {
  read: (p) => impl.read(p),
  write: (p, c, a) => impl.write(p, c, a),
  list: (d) => impl.list(d),
  remove: (p) => impl.remove(p),
};

export interface FetchResult { ok: boolean; status: number; nextUrl: string | null; xml: string; error?: string }
// Qualys 応答 XML は巨大になり得るので生 body。status/nextUrl は応答ヘッダから取る。
export async function fetchQualys(body: Record<string, unknown>): Promise<FetchResult> {
  const r = await fetch(`${RELAY}/qam/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  if (r.headers.get('X-QAM-Status') !== null) {
    const next = r.headers.get('X-QAM-Next');
    return { ok: r.ok, status: parseInt(r.headers.get('X-QAM-Status') || String(r.status), 10), nextUrl: next ? decodeURIComponent(next) : null, xml: text };
  }
  let err = `HTTP ${r.status}`;
  try { err = JSON.parse(text).error || err; } catch { /* ignore */ }
  return { ok: false, status: r.status, nextUrl: null, xml: '', error: err };
}

// Qualys ユーザ登録（/msp/user.php?action=add）。relay が Basic 認証＋プロキシで叩く。
// 取込の並列取得。種別のリストを 1 リクエストで渡し、relay 内部で並列に取得させる。
// 返るのは種別ごとのサマリだけ。XML 本体は fetchBatchResult で 1 種別ずつ生 body で受け取る
// （巨大な XML を JSON に包むと PS5.1 側が壊れるため）。
export interface FetchBatchItem { kind: string; ok: boolean; pages: number; bytes: number; error?: string }
export interface FetchBatchResult { ok: boolean; items?: FetchBatchItem[]; error?: string }
// since/states は kind='ticket' 用、after は検査(scan)用（launched_after_datetime）。他の種別では無視される。
export const fetchQualysBatch = (body: { kinds: string[]; base: string; user: string; pass?: string; secret?: string; proxy: string; since?: string; states?: string; after?: string }): Promise<FetchBatchResult> =>
  postJson('/qam/fetch-batch', body);

// 取得済み XML（複数ページは PAGE_SEP 連結）を受け取る。取り出すと relay 側からは消える。
export const PAGE_SEP = '\n<!-- page -->\n';
export async function fetchBatchResult(kind: string): Promise<string> {
  const r = await fetch(`${RELAY}/qam/fetch-batch/result?kind=${encodeURIComponent(kind)}`);
  if (!r.ok) { const d = await r.json().catch(() => ({} as any)); throw new Error(d.error || `取得結果を読めません (HTTP ${r.status})`); }
  return await r.text();
}

// レポート本体(PDF)。テキストで返すと壊れるので base64 で受け取る。
export interface ReportFetchResult { ok: boolean; status?: number; contentType?: string; base64?: string; xml?: string; error?: string }
export const qualysReportFetch = (body: { base: string; user: string; pass?: string; secret?: string; proxy: string; id: string }): Promise<ReportFetchResult> =>
  postJson('/qam/qualys/report-fetch', body);

export interface UserAddResult { ok: boolean; login?: string; error?: string; status?: number }
export const qualysUserAdd = (body: { base: string; user: string; pass: string; secret?: string; proxy: string; author?: string; fields: Record<string, string> }): Promise<UserAddResult> =>
  postJson('/qam/qualys/user-add', body);

// スケジュール登録（作成）。relay が form-urlencoded で POST し、応答XMLをそのまま返す。
export interface ScheduleAddResult { ok: boolean; status?: number; xml?: string; error?: string }
// author は監査ログ（api-audit.log）に残すため。認証情報はログに出さない。
export const qualysScheduleAdd = (body: {
  base: string; user: string; pass: string; secret?: string; proxy: string; path: string; author: string; fields: Record<string, string>;
}): Promise<ScheduleAddResult> => postJson('/qam/qualys/schedule-add', body);

// FQDN の名前解決（ブラウザからは引けないので relay に代行させる）。
// 1 件でも失敗し得るので、成否は結果の各要素で見る（呼び出し自体は成功扱い）。
// パスワードを平文で持たないための暗号化（relay の DPAPI に委ねる）。復号口は無い。
export async function protectSecret(value: string): Promise<string> {
  const d = await postJson('/qam/secret/protect', { value });
  if (!d?.ok || !d.secret) throw new Error(d?.error || '認証情報を保護できませんでした');
  return String(d.secret);
}

export interface ResolveRow { name: string; ok: boolean; addresses: string[]; error?: string }
export async function resolveHosts(names: string[]): Promise<ResolveRow[]> {
  const d = await postJson('/qam/resolve', { names });
  if (d?.error) throw new Error(d.error);
  const rows: ResolveRow[] = Array.isArray(d?.results) ? d.results : (d?.results ? [d.results] : []);
  return rows.map((r) => ({ ...r, addresses: Array.isArray(r.addresses) ? r.addresses : (r.addresses ? [r.addresses] : []) }));
}

// fiscalStartMonth: 年度開始月(1-12・既定4)。四半期の区切りに使う。
// inspectionAgPattern: 四半期検査の対象 AssetGroup を選ぶ正規表現（既定は接続点ID形式）。
// scanOptionProfile / mapOptionProfile: 検査登録時に既定で適用するオプションプロファイル（種別ごと）。
// scannerAppliance: 既定スキャナー（既定 External）。scheduleTimeZone: 既定タイムゾーン（既定 JP）。
// regions: 地域区分「ラベル=コード」のカンマ区切り（空なら既定6区分）。ドメイン名の末尾に使う。
// spSiteUrl / spLibrary: 管理データの保管先（SharePoint）。SPO を読む前に要るのでローカル設定に置く。
export interface RelayConfig { qualysBase: string; qualysUser: string; proxy: string; port: number; retentionDays: number; licenseLimit: number; userBusinessUnit: string; userCountry: string; fiscalStartMonth: number; inspectionAgPattern: string; scanOptionProfile: string; mapOptionProfile: string; scannerAppliance: string; scheduleTimeZone: string; regions: string; spSiteUrl: string; spLibrary: string;
  // 日次更新（検索リスト更新・レポート作成）で使う設定。
  searchListIds: string;    // 更新対象の動的検索リストID（カンマ/改行区切り・複数）
  cveXlsxPath: string;      // CVE対応策一覧の Excel（保管先ライブラリからの相対パス）
  reportTemplateJa: string; // SCANレポートのテンプレートID（日本語アカウント用）
  reportTemplateEn: string; // 同（英語アカウント用）
  // ↓ qam.env でのみ設定する（画面は表示のみ。POST では受け付けない）
  bundleSource: string; bundleLocalBase: string; logDir: string }
// 設定は relay が持つが、SharePoint ページ上で動くとき relay は Qualys 取得にしか要らない。
// relay が落ちていても保管先の判断はできるよう、直近値を控えておいて代用する。
const CFG_CACHE = 'qam:config-cache';
export const getConfig = async (): Promise<RelayConfig> => {
  try {
    const cfg = (await (await fetch(`${RELAY}/qam/config`)).json()) as RelayConfig;
    try { localStorage.setItem(CFG_CACHE, JSON.stringify(cfg)); } catch { /* 保存できなくても動かす */ }
    return cfg;
  } catch (e) {
    const cached = localStorage.getItem(CFG_CACHE);
    if (cached) return JSON.parse(cached) as RelayConfig;
    throw e;
  }
};
export const setConfig = async (patch: Partial<RelayConfig>): Promise<RelayConfig> => {
  const r = await fetch(`${RELAY}/qam/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  const d = await r.json().catch(() => ({} as any));
  if (!r.ok || d.error) throw new Error(`設定の保存に失敗: ${d.error ?? 'HTTP ' + r.status}`);
  return d;
};
export const shutdownRelay = (): Promise<unknown> => postJson('/qam/shutdown', {});


// 中継サーバの死活確認。起動していない/到達不能なら false（数秒でタイムアウト）。
export async function checkRelay(timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return (await fetch(`${RELAY}/qam/health`, { signal: ctrl.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(t); }
}
