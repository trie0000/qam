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
// AssetGroup タイトルの先頭〜最初の半角スペースまでが接続点ID（UI 側と同じ規則）。
// ここは UI に依存させないので、同じ規則をこのファイルにも置く。
export const settenIdOf = (title: string): string => (title || '').split(' ')[0];

// ── 資産・チケット ───────────────────────────────────────────────────────────
// ステータス。host list に載っている＝Qualys が生きていると認識している資産は空。
// AssetGroup には登録されているのに host list に居ないものは、スキャンで応答が無い
// （host not alive）とみなす。
export const RAS_NOT_ALIVE = 'host not alive';

export interface RasAsset {
  /** 行のキー。host list 由来はホストID、AssetGroup 由来だけの資産は 'ip:<IP>'。 */
  key: string;
  hostId: string;            // AssetGroup にしか無い資産では空
  settenId: string;
  ip: string;
  fqdn: string;
  status: string;            // '' | RAS_NOT_ALIVE
  businessCompany: string;   // マスター登録した事業会社（アクセス権の割当キー）
  managementCompany: string; // 自由入力
}

/** host list に無い資産の行キー。IP しか手掛かりが無いのでそれを使う。 */
export const rasKeyForIp = (ip: string): string => `ip:${ip}`;

// IPv4 → 整数。不正なら null。AssetGroup の IP_RANGE を展開するのに使う。
function ipToInt(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const intToIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * AssetGroup の IP 表記（'10.0.0.1' か '10.0.0.1-10.0.0.5'）を個々の IP に展開する。
 * ★レンジは際限なく大きくなり得る（/16 なら 65,536 件）ので上限を設ける。
 *   打ち切った分は呼び出し側が件数で気付けるよう、黙って捨てずに残数を返す。
 */
export function expandAgIps(entries: string[], limit: number): { ips: string[]; dropped: number } {
  const out: string[] = [];
  let dropped = 0;
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const dash = e.indexOf('-');
    if (dash < 0) { if (out.length < limit) out.push(e); else dropped++; continue; }
    const a = ipToInt(e.slice(0, dash));
    const b = ipToInt(e.slice(dash + 1));
    if (a === null || b === null || b < a) { if (out.length < limit) out.push(e); else dropped++; continue; }
    for (let n = a; n <= b; n++) {
      if (out.length >= limit) { dropped += b - n + 1; break; }
      out.push(intToIp(n));
    }
  }
  return { ips: [...new Set(out)], dropped };
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

// 独自RAS資産を組み立てる。元は2つ:
//   1. host list … Qualys が生きていると認識しているホスト（IP/FQDN が取れる）
//   2. AssetGroup の IP … host list に居ない＝スキャンで応答が無い（host not alive）
// ★host list だけを見ると not alive のホストが丸ごと抜ける。AssetGroup に登録が
//   あるのに host list に居ない IP を拾って補う。
//
// ただし「AssetGroup を今日更新した」場合は、IP を足した直後でまだスキャンが
// 回っていないだけの可能性がある。それを not alive と決めつけないよう、
// AssetGroup の最終更新日が基準日（＝取込日）と同じものは対象外にする。
//
// registered: 行キー → 登録済みの事業会社/管理会社（取込で入力が消えないように引き継ぐ）。
// agSetten:   hostId → 接続点ID（複数AG所属はカンマ区切り）。
export interface DeriveRasResult {
  assets: RasAsset[];
  /** IP レンジが大きすぎて展開を打ち切った件数（0 なら打ち切りなし）。 */
  droppedIps: number;
  /** 最終更新日が基準日と同じで、判断を保留した AssetGroup の接続点ID。 */
  pendingSetten: string[];
}

// 1 つの AssetGroup から展開する IP の上限。RAS の接続点にレンジが入っていると
// 際限なく増える（/16 で 65,536 件）ので歯止めを置く。
export const AG_IP_EXPAND_LIMIT = 1024;

export function deriveRasAssets(
  hosts: QamRecord[],
  groups: QamRecord[],
  agSetten: Record<string, string>,
  registered: Map<string, RasAsset>,
  baseDate: string,
  limit = AG_IP_EXPAND_LIMIT,
): DeriveRasResult {
  const out: RasAsset[] = [];
  const seenIp = new Set<string>();
  for (const h of hosts) {
    // 複数の接続点に属することがあるので、R 始まりのものだけを見る。
    const setten = (agSetten[h.key] ?? '').split(',').map((s) => s.trim()).filter(isRasSetten);
    if (!setten.length) continue;
    const prev = registered.get(h.key);
    const ip = h.scalar.IP ?? '';
    if (ip) seenIp.add(ip);
    out.push({
      key: h.key,
      hostId: h.key,
      settenId: setten.join(','),
      ip,
      fqdn: h.scalar.FQDN || h.scalar.DNS || '',
      status: '', // host list に居る＝生きている
      businessCompany: prev?.businessCompany ?? '',
      managementCompany: prev?.managementCompany ?? '',
    });
  }

  // AssetGroup 側に登録があって host list に居ない IP を拾う。
  let droppedIps = 0;
  const pendingSetten: string[] = [];
  const byIp = new Map<string, RasAsset>();
  for (const g of groups) {
    const sid = settenIdOf(g.name);
    if (!isRasSetten(sid)) continue;
    // 「今日更新された AssetGroup」は、IP を足した直後でまだスキャンされていない
    // 可能性があるので判断を保留する（not alive と決めつけない）。
    const updated = (g.info.LAST_UPDATE ?? '').slice(0, 10);
    if (updated && baseDate && updated >= baseDate) { pendingSetten.push(sid); continue; }
    const { ips, dropped } = expandAgIps(g.set.IPS ?? [], limit);
    droppedIps += dropped;
    for (const ip of ips) {
      if (seenIp.has(ip)) continue; // host list にある＝生きているので既に載せた
      const key = rasKeyForIp(ip);
      const hit = byIp.get(ip);
      if (hit) { // 同じ IP が複数の RAS 接続点に登録されている
        if (!hit.settenId.split(',').includes(sid)) hit.settenId += `,${sid}`;
        continue;
      }
      const prev = registered.get(key);
      const row: RasAsset = {
        key, hostId: '', settenId: sid, ip, fqdn: '', status: RAS_NOT_ALIVE,
        businessCompany: prev?.businessCompany ?? '',
        managementCompany: prev?.managementCompany ?? '',
      };
      byIp.set(ip, row);
      out.push(row);
    }
  }
  out.sort((a, b) => a.settenId.localeCompare(b.settenId) || a.ip.localeCompare(b.ip));
  return { assets: out, droppedIps, pendingSetten: [...new Set(pendingSetten)].sort() };
}

// チケットを独自RAS資産の分だけに絞る。事業会社は資産側の登録値を写す
// （チケットのリストだけでアクセス権を組めるようにするため）。
export function deriveRasTickets(tickets: QamTicket[], assets: RasAsset[], idByIp: Record<string, string>): RasTicket[] {
  // host not alive の行は hostId が空。空同士で当たらないよう、キーのある行だけを索引化する。
  const byHost = new Map(assets.filter((a) => a.hostId).map((a) => [a.hostId, a]));
  const out: RasTicket[] = [];
  for (const t of tickets) {
    // チケットに HOST_ID が入らない環境があるので IP からも引く。
    const hostId = t.hostId || idByIp[t.ip] || '';
    if (!hostId) continue;
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
