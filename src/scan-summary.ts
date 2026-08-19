// VM Scan Summary（/api/2.0/fo/scan/vm/summary/）の解析と、そこからの生死判定。
//
// ★なぜ host list ではだめか
//   host list は「一度でも検査できた資産」の台帳なので、載っている＝生きている、には
//   ならない。最終検査日も前回成功時のまま残る。「その回のスキャンで応答したか」は
//   スキャン結果側にしか無い。
//
// ★スキャン側の事故を not alive にしない
//   Qualys は失敗の種類を分けて返す（CANCELLED / ABORTED / BLOCKED /
//   FAILED_SLICE_HOSTS / EXCEEDED_SCAN_DURATION）。DEAD に混ざることはない。
//   結果を返せなかったスキャンは <SCAN_RESULTS> ごと落ちる。どちらも判定に使わない。
//
// ★それでも残る穴
//   スキャナは動いていて経路（FW/VPN/拠点回線）だけが落ちていると、ホストは本当に
//   応答しないので Qualys は正しく DEAD と返す。ここは Qualys からは区別できないので、
//   「接続点まるごと DEAD」を異常とみなして判定に使わない。
import { expandAgIps } from './ras';

/** 1回のスキャンから読み取った、判定に使う分だけ。 */
export interface ScanSummary {
  ref: string;
  /** 実施日時（SCAN_DATETIME。無ければ LAUNCH_DATETIME）。並べ替えのキー。 */
  at: string;
  status: string;          // FINISHED / ERROR / CANCELED …
  assetGroups: string[];   // 対象の AssetGroup 名（接続点の紐付けに使う）
  scanned: string[];       // 応答した IP
  dead: string[];          // 応答しなかった IP
  /** 判定に使えないスキャン（結果が無い・全滅・失敗）。理由を添える。 */
  unusable: string;
}

const IP_LIMIT = 65536;

const tag = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
const first = (xml: string, name: string): string => tag(xml, name)[0] ?? '';
const textOf = (xml: string, name: string): string => (first(xml, name) || '').replace(/<[^>]*>/g, '').trim();

/**
 * カテゴリ配下の IP を取り出す。
 * ★<IP_CSV> と <RANGES><RANGE>a-b</RANGE> の両方で返る。片方しか読まないと取りこぼす。
 */
export function ipsIn(block: string): string[] {
  if (!block) return [];
  const entries: string[] = [];
  for (const name of ['IP_CSV', 'IPV4_CSV']) {
    for (const csv of tag(block, name)) for (const v of csv.split(',')) { const s = v.trim(); if (s) entries.push(s); }
  }
  for (const r of tag(block, 'RANGE')) { const s = r.trim(); if (s) entries.push(s); }
  return expandAgIps(entries, IP_LIMIT).ips;
}

/** スキャン側の事故を表すカテゴリ。ここに入った分は「応答しなかった」ではない。 */
export const FAILED_CATEGORIES = ['CANCELLED', 'ABORTED', 'BLOCKED', 'FAILED_SLICE_HOSTS', 'EXCEEDED_SCAN_DURATION'] as const;

/** 接続点まるごと落ちたと見なす割合。これを超えたらスキャン側の異常を疑う。 */
export const DEAD_RATIO_LIMIT = 0.8;
/**
 * 何日ぶんのスキャンを取るか。
 * ★日次スキャンが数日飛んでも判定できるだけの幅が要る。狭すぎると「材料が無い」で
 *   据え置きが続き、いつまでも古い判定のままになる。
 */
export const SCAN_SUMMARY_DAYS = 14;
/** 何回続けて応答しなかったら host not alive にするか。1回だけでは変えない。 */
export const DEAD_STREAK = 2;

export function parseScanSummaryXml(xml: string, deadRatioLimit = DEAD_RATIO_LIMIT): ScanSummary[] {
  if (!xml.trim()) return [];
  const out: ScanSummary[] = [];
  for (const s of tag(xml, 'SCAN_SUMMARY')) {
    const ref = textOf(s, 'SCAN_REFERENCE');
    if (!ref) continue;
    const input = first(s, 'SCAN_INPUT');
    const details = first(s, 'SCAN_DETAILS');
    const status = textOf(details, 'STATUS');
    const at = textOf(input, 'SCAN_DATETIME') || textOf(details, 'LAUNCH_DATETIME');
    const agBlock = first(input, 'ASSET_GROUP_LIST');
    const assetGroups = tag(agBlock, 'ASSET_GROUP').map((g) => textOf(g, 'NAME')).filter(Boolean);
    const results = first(s, 'SCAN_RESULTS');
    // ★結果が無いスキャンは <SCAN_RESULTS> ごと落ちる（ドキュメント明記）。判定に使わない。
    if (!results) { out.push({ ref, at, status, assetGroups, scanned: [], dead: [], unusable: '結果がありません' }); continue; }
    const data = first(results, 'HOSTS_DATA');
    const scanned = ipsIn(first(data, 'SCANNED'));
    const dead = ipsIn(first(data, 'DEAD'));
    const failed = FAILED_CATEGORIES.flatMap((c) => ipsIn(first(data, c)));
    let unusable = '';
    if (status && !/^FINISHED$/i.test(status)) unusable = `スキャンが正常終了していません（${status}）`;
    else if (!scanned.length && !dead.length) unusable = '応答の記録がありません';
    else if (dead.length / (scanned.length + dead.length) >= deadRatioLimit) {
      // ★資産が一斉に死ぬより、経路やスキャナ側の異常のほうがずっとありそう。
      unusable = `対象の ${Math.round((dead.length / (scanned.length + dead.length)) * 100)}% が応答なし（スキャン側の異常を疑います）`;
    } else if (failed.length && !scanned.length) unusable = 'スキャンに失敗しています';
    out.push({ ref, at, status, assetGroups, scanned, dead, unusable });
  }
  // 新しい順に並べる（判定は新しいほうから見る）。
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

export type AliveVerdict = 'alive' | 'dead' | 'unknown';

export interface AliveJudgement {
  /** IP → 判定。unknown は「判定できる材料が無い」＝前の状態を据え置く。 */
  byIp: Map<string, { verdict: AliveVerdict; at: string }>;
  /** 判定に使わなかったスキャン（画面に出して気づかせる）。 */
  skipped: { ref: string; at: string; reason: string }[];
}

/**
 * スキャン結果から IP ごとの生死を決める。
 * - 直近の（使えるスキャンでの）記録が「応答あり」なら alive
 * - 直近 streak 回が続けて「応答なし」なら dead
 * - それ以外（記録が無い・応答なしが streak 未満）は unknown ＝ 前の状態を据え置く
 */
export function judgeAlive(summaries: ScanSummary[], streak = DEAD_STREAK): AliveJudgement {
  const byIp = new Map<string, { verdict: AliveVerdict; at: string }>();
  const skipped: { ref: string; at: string; reason: string }[] = [];
  // 新しい順に見て、IP ごとの記録を積む。
  const seen = new Map<string, { alive: boolean; at: string }[]>();
  for (const s of summaries) {
    if (s.unusable) { skipped.push({ ref: s.ref, at: s.at, reason: s.unusable }); continue; }
    for (const ip of s.scanned) (seen.get(ip) ?? seen.set(ip, []).get(ip)!).push({ alive: true, at: s.at });
    for (const ip of s.dead) (seen.get(ip) ?? seen.set(ip, []).get(ip)!).push({ alive: false, at: s.at });
  }
  for (const [ip, hist] of seen) {
    if (!hist.length) continue;
    if (hist[0].alive) { byIp.set(ip, { verdict: 'alive', at: hist[0].at }); continue; }
    // 先頭から続けて「応答なし」が何回あるか。
    let n = 0;
    while (n < hist.length && !hist[n].alive) n++;
    // ★1回だけの応答なしで not alive にしない。まだ足りないうちは据え置く。
    byIp.set(ip, n >= streak ? { verdict: 'dead', at: hist[0].at } : { verdict: 'unknown', at: hist[0].at });
  }
  return { byIp, skipped };
}
