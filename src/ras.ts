// 独自RAS: 接続点IDが 'R' で始まる接続点に属する資産と、その資産で見つかった脆弱性チケット。
//
// 通常の資産一覧と違い、この2つは SharePoint の**リスト**として持つ。理由はアクセス権で、
// 事業会社ごとに参照範囲を分けるにはアイテム単位権限が要り、それはリストにしか付けられない
// （スナップショットは1ファイル＝全行なので、行ごとに出し分けできない）。
//
// 権限の考え方（社内の別アプリで実績のある方式に合わせる）:
//   - 管理者グループ … 全アイテムに **フルコントロール**（更新できる人）
//   - 事業会社グループ … その事業会社のアイテムに **読み取り**（参照だけ）
//   - 割当のキーは行IDではなく **事業会社名**。行は取込のたびに作り直されるので、
//     行IDに紐づけると割当が消える。
//
// このファイルは UI にも SharePoint にも依存しない（vitest で検証するため）。
import type { QamRecord, QamTicket } from './types';

// 接続点IDの先頭がこの文字なら独自RAS。運用ルールなので1箇所に置く。
export const RAS_PREFIX = 'R';
// 接続点IDは英数字の並び。'R' 始まりだけを対象にする（小文字は別物として扱わない）。
export const isRasSetten = (settenId: string): boolean => (settenId ?? '').trim().startsWith(RAS_PREFIX);

// ── 資産・チケット ───────────────────────────────────────────────────────────
export interface RasAsset {
  hostId: string;
  settenId: string;
  ip: string;
  fqdn: string;
  businessCompany: string;   // マスター登録した事業会社（アクセス権の割当キー）
  managementCompany: string; // 自由入力
}

export interface RasTicket {
  number: string;
  state: string;
  hostId: string;
  ip: string;
  fqdn: string;
  settenId: string;
  businessCompany: string; // 権限判定のために資産から写しておく（リスト単体で権限を組めるように）
  created: string;
}

// host スナップショットから独自RAS資産を組み立てる。
// 登録済みの事業会社/管理会社は hostId で引き継ぐ（取込のたびに入力が消えないように）。
// agSetten: hostId → 接続点ID（複数AG所属はカンマ区切り）。
export function deriveRasAssets(
  hosts: QamRecord[], agSetten: Record<string, string>, registered: Map<string, RasAsset>,
): RasAsset[] {
  const out: RasAsset[] = [];
  for (const h of hosts) {
    // 複数の接続点に属することがあるので、R 始まりのものだけを見る。
    const setten = (agSetten[h.key] ?? '').split(',').map((s) => s.trim()).filter(isRasSetten);
    if (!setten.length) continue;
    const prev = registered.get(h.key);
    out.push({
      hostId: h.key,
      settenId: setten.join(','),
      ip: h.scalar.IP ?? '',
      fqdn: h.scalar.FQDN || h.scalar.DNS || '',
      businessCompany: prev?.businessCompany ?? '',
      managementCompany: prev?.managementCompany ?? '',
    });
  }
  return out.sort((a, b) => a.settenId.localeCompare(b.settenId) || a.ip.localeCompare(b.ip));
}

// チケットを独自RAS資産の分だけに絞る。事業会社は資産側の登録値を写す
// （チケットのリストだけでアクセス権を組めるようにするため）。
export function deriveRasTickets(tickets: QamTicket[], assets: RasAsset[], idByIp: Record<string, string>): RasTicket[] {
  const byHost = new Map(assets.map((a) => [a.hostId, a]));
  const out: RasTicket[] = [];
  for (const t of tickets) {
    // チケットに HOST_ID が入らない環境があるので IP からも引く。
    const hostId = t.hostId || idByIp[t.ip] || '';
    const a = byHost.get(hostId);
    if (!a) continue;
    out.push({
      number: t.number, state: t.state, hostId,
      ip: t.ip || a.ip, fqdn: t.fqdn || a.fqdn, settenId: a.settenId,
      businessCompany: a.businessCompany, created: t.created,
    });
  }
  return out.sort((x, y) => Number(y.number) - Number(x.number));
}

// ── アクセス権 ───────────────────────────────────────────────────────────────
export interface RasPerms {
  /** 全アイテムにフルコントロールを付ける SP 権限グループ ID（更新できる管理者）。 */
  adminGroupIds: number[];
  /** 事業会社名 → 読み取りを付ける SP 権限グループ ID。空配列は「登録済み・割当なし」。 */
  byBusinessCompany: Record<string, number[]>;
}

export const EMPTY_RAS_PERMS: RasPerms = { adminGroupIds: [], byBusinessCompany: {} };

const ids = (v: unknown): number[] =>
  (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []);

/** 保存済み JSON を安全な形に整える（壊れていても落とさない）。 */
export function normalizeRasPerms(v: unknown): RasPerms {
  const o = (v ?? {}) as Record<string, unknown>;
  const by: Record<string, number[]> = {};
  const src = (o.byBusinessCompany ?? {}) as Record<string, unknown>;
  if (src && typeof src === 'object') {
    for (const [company, list] of Object.entries(src)) {
      const name = String(company).trim();
      // 割当が空でもキーは残す。「登録済み・割当なし」という状態を持たせるため
      // （消すと画面から会社が消えて、登録し直しになる）。
      if (name) by[name] = ids(list);
    }
  }
  return { adminGroupIds: ids(o.adminGroupIds), byBusinessCompany: by };
}

/** 登録済みの事業会社（表示順）。 */
export const registeredCompanies = (p: RasPerms): string[] =>
  Object.keys(p.byBusinessCompany).sort((a, b) => a.localeCompare(b, 'ja'));

/** その事業会社に割り当てられたグループ。未設定なら空（＝管理者だけが見られる）。 */
export const groupIdsFor = (company: string, p: RasPerms): number[] =>
  p.byBusinessCompany[String(company ?? '').trim()] ?? [];

/**
 * 権限を適用してよいか。
 * ★管理者グループが必須。ここを「事業会社の割当だけでも可」にすると、
 *   管理者グループ未設定のまま継承を解除して**誰も更新できないアイテム**ができる。
 */
export const canApplyPerms = (p: RasPerms): boolean => p.adminGroupIds.length > 0;

/** 一括入力（1行1件）を事業会社名の配列にする。Excel 貼付けを想定しタブ区切りは先頭列だけ使う。 */
export function parseCompanyList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const name = (line.split('\t')[0] ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 一括登録の結果を既存の割当にマージする（既存の割当は消さない）。 */
export function mergeCompanies(p: RasPerms, names: string[]): RasPerms {
  const next: Record<string, number[]> = {};
  for (const name of names) next[name] = p.byBusinessCompany[name] ?? [];
  return { adminGroupIds: [...p.adminGroupIds], byBusinessCompany: next };
}

/** SP のロール定義 ID。RoleTypeKind: 2=読み取り / 5=フルコントロール。 */
export interface PermRoles { read: number; full: number }
export function pickRoles(defs: { Id: number; RoleTypeKind: number }[]): PermRoles {
  const byKind = (k: number): number | undefined => defs.find((d) => d.RoleTypeKind === k)?.Id;
  const read = byKind(2);
  const full = byKind(5);
  if (!read || !full) throw new Error('サイトのロール定義（読み取り / フルコントロール）を取得できません');
  return { read, full };
}

/** 1 アイテムに付与する内容。 */
export interface ItemPermPlan { id: number; businessCompany: string; full: number[]; read: number[] }

/**
 * アイテムごとの付与内容を組み立てる。
 * ★同じグループに2つのロールを付けない。SP は後勝ちにならないので、フルコントロールの
 *   直後に読み取りを付けると権限が下がる（管理者が更新できなくなる）。
 */
export function buildItemPermPlan(items: { id: number; businessCompany: string }[], p: RasPerms): ItemPermPlan[] {
  const admin = [...new Set(p.adminGroupIds)];
  const adminSet = new Set(admin);
  return items.map((it) => ({
    id: it.id,
    businessCompany: it.businessCompany,
    full: admin,
    read: groupIdsFor(it.businessCompany, p).filter((g) => !adminSet.has(g)),
  }));
}

/** 割当が1つも無い事業会社（＝管理者しか見られない）。画面で注意を出すために使う。 */
export function companiesWithoutGroups(p: RasPerms): string[] {
  return registeredCompanies(p).filter((c) => groupIdsFor(c, p).length === 0);
}

/** 事業会社が未登録のRAS資産（＝どのグループにも見えない）。取り残しに気付けるように出す。 */
export function assetsWithoutCompany(assets: RasAsset[]): RasAsset[] {
  return assets.filter((a) => !a.businessCompany.trim());
}
