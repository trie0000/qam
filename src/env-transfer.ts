// 開発環境 ↔ 本番環境 の設定の持ち運び。
//
// ★いちばん大事な点: **SharePoint グループの ID はサイトごとに違う**。
//   アクセス権は `{ 事業会社: [12, 13] }` のようにグループ ID で持っているので、
//   ID のまま別サイトへ写すと **別のグループに権限が付く**。事故になる。
//   持ち出すときに ID → グループ名、持ち込むときに グループ名 → ID へ移送先で引き直す。
//   引けない名前は名指しで報告して、黙って落とさない。
//
// ★保存先が2つに分かれていることに注意する。
//   - マスタ情報・メールのテンプレート: SharePoint の設定リスト（**環境ごとに別**）
//   - それ以外の共通設定: 中継サーバの qam.env（**端末ごと**。環境で分かれていない）
//   同じ端末で両環境を使うなら中継サーバの設定は元から共通なので、運ぶ必要があるのは
//   別の端末に移すときだけ。ファイル経由でのみ運ぶ（サイト間の直接コピーには載せない）。
//
// ★資産データ・チケット・スナップショットは運ばない（Qualys から取り直せる）。
//
// UI にも SharePoint にも依存しない（テストしやすくするため）。
import { normalizeRasPerms, type RasPerms } from './ras';

/** 持ち運ぶ単位。画面のチェックボックスと 1:1。 */
export type TransferPart = 'master' | 'common';

export const PART_LABEL: Record<TransferPart, string> = {
  master: 'マスタ情報',
  common: '共通設定',
};

/**
 * 「共通設定」として運ぶ中継サーバの設定キー。
 * ★ここに載せてはいけないもの:
 *   - spSiteUrl / spLibrary … **環境そのもの**を指す。運ぶと移送先が元環境を向いてしまう
 *   - port / bundleSource / bundleLocalBase / logDir / relayContract … qam.env 専用（POST で受け付けない）
 *   - 認証情報 … そもそも中継サーバの設定に入っていない（端末の localStorage に暗号文で持つ）
 */
export const TRANSFERABLE_CONFIG_KEYS = [
  'qualysBase', 'qualysUser', 'proxy', 'retentionDays', 'licenseLimit',
  'userBusinessUnit', 'userCountry', 'fiscalStartMonth', 'inspectionAgPattern',
  'scanOptionProfile', 'mapOptionProfile', 'scannerAppliance', 'scheduleTimeZone', 'regions',
  'searchListIds', 'cveXlsxPath',
  'reportTemplateJa', 'reportTemplateEn', 'ticketTemplateJa', 'ticketTemplateEn',
  'intraLoginUrl', 'intraPageUrl', 'intraFilePattern',
] as const;

/** 運んではいけない設定キー（載せると移送先が壊れる/元環境を向く）。 */
export const BLOCKED_CONFIG_KEYS = [
  'spSiteUrl', 'spLibrary', 'port', 'bundleSource', 'bundleLocalBase', 'logDir', 'relayContract',
] as const;

/** 差分プレビューの表示名。★キー名のまま出すと何の設定か分からない。 */
export const CONFIG_LABEL: Record<string, string> = {
  qualysBase: 'Qualys 接続先 POD', qualysUser: 'Qualys アカウント', proxy: 'プロキシ URL',
  retentionDays: '保存期間（日）', licenseLimit: 'ライセンス上限',
  userBusinessUnit: 'ユーザ登録: 事業部', userCountry: 'ユーザ登録: 国',
  fiscalStartMonth: '年度開始月', inspectionAgPattern: '四半期検査の対象パターン',
  scanOptionProfile: 'SCAN のオプションプロファイル', mapOptionProfile: 'MAP のオプションプロファイル',
  scannerAppliance: '既定スキャナー', scheduleTimeZone: '既定タイムゾーン', regions: '地域区分',
  searchListIds: '検索リストID', cveXlsxPath: 'CVE対応策一覧の Excel',
  reportTemplateJa: 'SCANレポートのテンプレートID（日本語）', reportTemplateEn: 'SCANレポートのテンプレートID（英語）',
  ticketTemplateJa: 'TicketレポートのテンプレートID（日本語）', ticketTemplateEn: 'TicketレポートのテンプレートID（英語）',
  intraLoginUrl: '体制表: ログインURL', intraPageUrl: '体制表: ページURL', intraFilePattern: '体制表: ファイル名パターン',
};

export interface SiteGroup { id: number; title: string }

/**
 * 環境をまたいで運ぶ内容。
 * ★グループは **名前** で持つ（ID はサイトごとに違うため）。
 */
export interface EnvBundle {
  /** 形式の版。読み込み側が古い/新しい形式を判別する。 */
  version: 1;
  /** 書き出した日時（ISO）。 */
  exportedAt: string;
  /** 書き出し元のサイト URL（取り違え防止のため画面に出す）。 */
  sourceSite: string;
  /** マスタ情報（マスター管理の画面で登録するもの）。 */
  master?: {
    /** 管理者グループの **名前**。 */
    adminGroups: string[];
    /** 事業会社 → 参照グループの **名前**。空配列は「登録済み・割当なし」。 */
    byBusinessCompany: Record<string, string[]>;
    /** 事業会社 → 略称（管理CSV の取込で使う）。 */
    aliasesByCompany: Record<string, string[]>;
    /** 事業会社 → 体制表（宛先Excel）の「管轄範囲」の表記。 */
    contactNameByCompany: Record<string, string>;
  };
  /** 共通設定。SharePoint 側（メール）と中継サーバ側（config）で保存先が違う。 */
  common?: {
    /** 中継サーバの設定。TRANSFERABLE_CONFIG_KEYS だけを入れる。 */
    config: Record<string, unknown>;
    /** メールのテンプレート（SharePoint の設定リスト）。 */
    mail: unknown;
  };
}

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** 設定 → 持ち出す内容。グループ ID は名前に置き換える。 */
export function toBundle(
  src: { perms: RasPerms; mail: unknown; config: Record<string, unknown> },
  groups: SiteGroup[],
  parts: TransferPart[],
  sourceSite: string,
  nowIso: string,
): EnvBundle {
  const nameById = new Map(groups.map((g) => [g.id, g.title]));
  const bundle: EnvBundle = { version: 1, exportedAt: nowIso, sourceSite };

  if (parts.includes('master')) {
    const p = normalizeRasPerms(src.perms);
    // ★引けなかった ID は落とす。名前が分からないものを持ち込んでも当てられない。
    const names = (ids: number[]): string[] =>
      [...new Set(ids.map((id) => nameById.get(id)).filter((t): t is string => !!t))];
    bundle.master = {
      adminGroups: names(p.adminGroupIds),
      byBusinessCompany: Object.fromEntries(
        Object.entries(p.byBusinessCompany).map(([c, ids]) => [c, names(ids)]),
      ),
      aliasesByCompany: { ...p.aliasesByCompany },
      contactNameByCompany: { ...p.contactNameByCompany },
    };
  }

  if (parts.includes('common')) {
    const config: Record<string, unknown> = {};
    for (const k of TRANSFERABLE_CONFIG_KEYS) {
      const v = src.config[k];
      if (v !== undefined) config[k] = v;
    }
    bundle.common = { config, mail: src.mail ?? null };
  }
  return bundle;
}

/** 持ち出せなかったグループ ID（移送元で名前を引けないもの。画面に出して気づかせる）。 */
export function unresolvedGroupIds(perms: RasPerms, groups: SiteGroup[]): number[] {
  const known = new Set(groups.map((g) => g.id));
  const p = normalizeRasPerms(perms);
  const all = [...p.adminGroupIds, ...Object.values(p.byBusinessCompany).flat()];
  return [...new Set(all.filter((id) => !known.has(id)))].sort((a, b) => a - b);
}

export interface ChangeRow { field: string; before: string; after: string }

export interface ApplyResult {
  /** 反映後の値（まだ保存はしていない）。 */
  perms: RasPerms;
  mail: unknown;
  config: Record<string, unknown>;
  /** 移送先に無かったグループ名。権限が付かないので必ず画面に出す。 */
  missingGroups: string[];
  /** 実際に変わる項目（プレビュー用）。 */
  changes: ChangeRow[];
}

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '(未設定)';
  if (Array.isArray(v)) return v.length ? `${v.length} 件` : '(なし)';
  if (typeof v === 'object') return `${Object.keys(v as object).length} 件`;
  return String(v);
};

/** 持ち込む内容を移送先の値に反映する。グループ名は移送先の ID に引き直す。 */
export function applyBundle(
  current: { perms: RasPerms; mail: unknown; config: Record<string, unknown> },
  bundle: EnvBundle,
  groups: SiteGroup[],
  parts: TransferPart[],
): ApplyResult {
  // ★大文字小文字・前後空白の違いで引けないことがあるので、揃えてから引く。
  const idByName = new Map(groups.map((g) => [g.title.trim().toLowerCase(), g.id]));
  const missing = new Set<string>();
  const changes: ChangeRow[] = [];
  const put = (field: string, before: unknown, after: unknown): void => {
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
    changes.push({ field, before: show(before), after: show(after) });
  };

  let perms = normalizeRasPerms(current.perms);
  let mail = current.mail;
  const config: Record<string, unknown> = {};

  if (parts.includes('master') && bundle.master) {
    const ids = (names: string[]): number[] => {
      const out: number[] = [];
      for (const n of names) {
        const id = idByName.get(text(n).toLowerCase());
        if (id === undefined) { missing.add(n); continue; }
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };
    const next = normalizeRasPerms({
      adminGroupIds: ids(bundle.master.adminGroups),
      byBusinessCompany: Object.fromEntries(
        Object.entries(bundle.master.byBusinessCompany).map(([c, names]) => [c, ids(names)]),
      ),
      aliasesByCompany: bundle.master.aliasesByCompany,
      contactNameByCompany: bundle.master.contactNameByCompany,
    });
    put('事業会社', Object.keys(perms.byBusinessCompany), Object.keys(next.byBusinessCompany));
    put('管理者グループ', perms.adminGroupIds, next.adminGroupIds);
    put('事業会社ごとの参照グループ', perms.byBusinessCompany, next.byBusinessCompany);
    put('略称', perms.aliasesByCompany, next.aliasesByCompany);
    put('体制表の会社名', perms.contactNameByCompany, next.contactNameByCompany);
    perms = next;
  }

  if (parts.includes('common') && bundle.common) {
    for (const k of TRANSFERABLE_CONFIG_KEYS) {
      const v = bundle.common.config[k];
      if (v === undefined) continue;
      // ★同じ値なら送らない。中継サーバへの書き込みを無駄に増やさないため。
      if (JSON.stringify(current.config[k] ?? null) === JSON.stringify(v)) continue;
      put(CONFIG_LABEL[k] ?? k, current.config[k], v);
      config[k] = v;
    }
    if (bundle.common.mail !== null && bundle.common.mail !== undefined) {
      put('メールのテンプレート', current.mail, bundle.common.mail);
      mail = bundle.common.mail;
    }
  }

  return {
    perms, mail, config,
    missingGroups: [...missing].sort((a, b) => a.localeCompare(b, 'ja')),
    changes,
  };
}

/** 保存値が壊れていても落ちないように整える（ファイル読み込み用）。 */
export function normalizeBundle(v: unknown): EnvBundle | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.version !== 1) return null;
  const b: EnvBundle = { version: 1, exportedAt: text(o.exportedAt), sourceSite: text(o.sourceSite) };

  const strs = (x: unknown): string[] =>
    (Array.isArray(x) ? [...new Set(x.map((s) => text(s)).filter(Boolean))] : []);
  const recArr = (x: unknown): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        const key = text(k);
        if (key) out[key] = strs(val);
      }
    }
    return out;
  };
  const recStr = (x: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        const key = text(k);
        if (key && text(val)) out[key] = text(val);
      }
    }
    return out;
  };

  const m = o.master as Record<string, unknown> | undefined;
  if (m && typeof m === 'object') {
    b.master = {
      adminGroups: strs(m.adminGroups),
      byBusinessCompany: recArr(m.byBusinessCompany),
      aliasesByCompany: recArr(m.aliasesByCompany),
      contactNameByCompany: recStr(m.contactNameByCompany),
    };
  }

  const c = o.common as Record<string, unknown> | undefined;
  if (c && typeof c === 'object') {
    // ★知らないキー・運んではいけないキーは捨てる。ファイルは手で編集できるので、
    //   spSiteUrl などが紛れ込むと移送先が元環境を向いてしまう。
    const src = (c.config ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    if (src && typeof src === 'object') {
      for (const k of TRANSFERABLE_CONFIG_KEYS) if (src[k] !== undefined) config[k] = src[k];
    }
    b.common = { config, mail: c.mail ?? null };
  }
  return b;
}

/**
 * 2つのサイト URL が同じオリジンか。
 * ★同じテナント内なら fetch で直接読み書きできる。別テナント（別オリジン）は
 *   ブラウザが遮るので、ファイル経由でしか運べない。
 */
export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase(); }
  catch { return false; }
}

/** 同じサイトを指しているか（自分自身へのコピーを止めるため。末尾スラッシュ・大小の違いを吸収）。 */
export function sameSite(a: string, b: string): boolean {
  const norm = (s: string): string => {
    try { const u = new URL(s); return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase(); }
    catch { return ''; }
  };
  const x = norm(a);
  return !!x && x === norm(b);
}

/** ファイル名（書き出し時）。 */
export function bundleFileName(parts: TransferPart[], nowIso: string): string {
  const stamp = nowIso.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `qam-settings-${parts.join('+')}-${stamp}.json`;
}
