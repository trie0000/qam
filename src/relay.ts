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

// store.ts が使う FileBackend を relay /qam/file で実装。
// 大きなファイル本体は JSON で包まず「生 body」で授受する（PS5.1 の ConvertTo/From-Json は
// 大きな文字列で落ちるため）。path/append はクエリで渡す。
export const relayBackend: FileBackend = {
  async read(path) {
    const r = await fetch(`${RELAY}/qam/file?path=${encodeURIComponent(path)}`);
    if (r.status === 404) return null; // 未存在
    if (!r.ok) throw new Error(`読込に失敗 (${path}): HTTP ${r.status}`);
    return await r.text();
  },
  async write(path, content, append) {
    const r = await fetch(`${RELAY}/qam/file?path=${encodeURIComponent(path)}&append=${append ? '1' : '0'}`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: content,
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`保存に失敗 (${path}): HTTP ${r.status}${t ? ' ' + t.slice(0, 120) : ''}`); }
  },
  async list(dir) {
    const r = await fetch(`${RELAY}/qam/file/list?dir=${encodeURIComponent(dir)}`);
    return (await r.json().catch(() => ({}))).names ?? [];
  },
  async remove(path) {
    const r = await fetch(`${RELAY}/qam/file/remove`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({} as any)); throw new Error(`削除に失敗 (${path}): ${d.error ?? 'HTTP ' + r.status}`); }
  },
};

// 実際に使う保管先は起動時に決まる（local = relay のファイル / sp = SharePoint ライブラリ）。
// 呼び出し側は `backend` を import したままでよいよう、差し替え可能な委譲にしておく。
let impl: FileBackend = relayBackend;
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

export interface SessionResult { ok: boolean; status?: number; error?: string }
export const qualysLogin = (creds: { base: string; user: string; pass: string; proxy: string }): Promise<SessionResult> => postJson('/qam/qualys/login', creds);
export const qualysLogout = (): Promise<SessionResult> => postJson('/qam/qualys/logout', {});

// fiscalStartMonth: 年度開始月(1-12・既定4)。四半期の区切りに使う。
// inspectionAgPattern: 四半期検査の対象 AssetGroup を選ぶ正規表現（既定は接続点ID形式）。
// scanOptionProfile / mapOptionProfile: 検査登録時に既定で適用するオプションプロファイル（種別ごと）。
// scannerAppliance: 既定スキャナー（既定 External）。scheduleTimeZone: 既定タイムゾーン（既定 JP）。
// regions: 地域区分「ラベル=コード」のカンマ区切り（空なら既定6区分）。ドメイン名の末尾に使う。
// storageMode: 管理データの保管先。local=relay のデータディレクトリ / sp=SharePoint ライブラリ。
//   sp は「アプリが SharePoint ページのオリジンで動いている」ことが前提（同一オリジン Cookie 認証）。
// spSiteUrl / spLibrary: sp のときの接続先。どちらも SPO を読む前に要るのでローカル設定に置く。
export interface RelayConfig { qualysBase: string; qualysUser: string; proxy: string; port: number; retentionDays: number; licenseLimit: number; backupIntervalMin: number; backupRetentionDays: number; userBusinessUnit: string; userCountry: string; fiscalStartMonth: number; inspectionAgPattern: string; scanOptionProfile: string; mapOptionProfile: string; scannerAppliance: string; scheduleTimeZone: string; regions: string; storageMode: 'local' | 'sp'; spSiteUrl: string; spLibrary: string }
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

// バックアップ（データディレクトリ全体の zip 退避/展開）。zip化・展開はファイルの所在地である relay 側で行う。
export interface BackupResult { ok: boolean; files?: number; error?: string }
export const backupNow = (slot: string): Promise<BackupResult> => postJson('/qam/backup', { slot });
export const restoreNow = (slot: string): Promise<BackupResult> => postJson('/qam/restore', { slot });

// 中継サーバの死活確認。起動していない/到達不能なら false（数秒でタイムアウト）。
export async function checkRelay(timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return (await fetch(`${RELAY}/qam/health`, { signal: ctrl.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(t); }
}
