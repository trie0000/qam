// 日次更新: 取込 → 独自RAS の更新 → 検索リストの更新 → 新規脆弱性のレポート作成。
// ここは判断だけを持つ（UI・SharePoint・Qualys に依存しない）。
import type { RasTicket } from './ras';
import type { SearchListResult } from './searchlist';

// チケットの状態変化。一覧のチケットID横にラベルで出す。
export type TicketChange = '' | 'new' | 'closed' | 'reopened';

export const TICKET_CHANGE_LABEL: Record<Exclude<TicketChange, ''>, string> = {
  new: '新規',
  closed: 'クローズ',
  reopened: '再検知',
};

/** Qualys の状態のうち「未対応で開いている」もの。RESOLVED/CLOSED/IGNORED は閉じている扱い。 */
export const isOpenState = (state: string): boolean => (state ?? '').trim().toUpperCase() === 'OPEN';

/**
 * 前回の取込と比べた変化。
 * ★「前回が無い＝新規」ではない。初回取込では全件が前回無しになるので、
 *   それを全部「新規」にすると一覧が新規で埋まる。呼び出し側が初回かどうかを渡す。
 */
export function classifyTicketChange(prev: RasTicket | undefined, next: RasTicket, firstRun: boolean): TicketChange {
  const open = isOpenState(next.state);
  if (!prev) return firstRun ? '' : (open ? 'new' : '');
  const wasOpen = isOpenState(prev.state);
  if (wasOpen && !open) return 'closed';
  if (!wasOpen && open) return 'reopened';
  return '';
}

export interface TicketChangeResult {
  ticket: RasTicket;
  change: TicketChange;
}

/** 一覧ぶんの変化を判定する。prev は前回の一覧（チケット番号で引く）。 */
export function classifyTickets(prev: RasTicket[], next: RasTicket[]): TicketChangeResult[] {
  const byNo = new Map(prev.map((t) => [t.number, t]));
  const firstRun = prev.length === 0;
  return next.map((t) => ({ ticket: t, change: classifyTicketChange(byNo.get(t.number), t, firstRun) }));
}

/** レポートを作る対象＝新しく開いた（新規 or 再検知）チケットのホスト。 */
export interface ReportTarget { hostId: string; ip: string; fqdn: string; tickets: string[] }

export function reportTargets(results: TicketChangeResult[]): ReportTarget[] {
  const byHost = new Map<string, ReportTarget>();
  for (const r of results) {
    if (r.change !== 'new' && r.change !== 'reopened') continue;
    // ★レポートはホスト単位。IP が無いと Qualys に対象を渡せないので落とす
    //   （host not alive の資産にはチケットが付かないので、通常ここには来ない）。
    if (!r.ticket.ip) continue;
    const key = r.ticket.hostId || r.ticket.ip;
    const hit = byHost.get(key);
    if (hit) { hit.tickets.push(r.ticket.number); continue; }
    byHost.set(key, { hostId: r.ticket.hostId, ip: r.ticket.ip, fqdn: r.ticket.fqdn, tickets: [r.ticket.number] });
  }
  return [...byHost.values()].sort((a, b) => a.ip.localeCompare(b.ip));
}

/** レポートの保存先。保管先ライブラリからの相対パス。 */
export const reportPath = (stamp: string, ip: string, lang: 'ja' | 'en', kind: 'scan' | 'ticket' = 'scan'): string =>
  `reports/${stamp.slice(0, 10)}/${ip.replace(/[^\w.-]/g, '_')}-${kind}-${lang}-${stamp}.pdf`;

/** レポートのタイトル（Qualys 側に残る名前）。128 文字まで。 */
export const reportTitle = (ip: string, fqdn: string, stamp: string): string =>
  `QAM RAS ${ip}${fqdn ? ` (${fqdn})` : ''} ${stamp}`.slice(0, 128);

export interface DailyRunSummary {
  ingested: string[];        // 取り込んだ種別
  ticketsNew: number;
  ticketsClosed: number;
  ticketsReopened: number;
  searchLists: SearchListResult[];
  /** 検索リストの補足（作り直しを行った等）。実行しなかったものとは区別する。 */
  searchNote?: string;
  reports: { ip: string; lang: 'ja' | 'en'; kind: 'scan' | 'ticket'; path?: string; error?: string }[];
  notes: string[];
  cveList?: string[]; // その実行で読んだ CVE対応策一覧（2度読みしないため）           // 実行しなかった理由など（黙って飛ばさない）
}

/**
 * 同時に走らせるレポートの本数。
 * ★Qualys は「同時に走らせられるレポート数」に上限があり、超えると launch が
 *   その場で失敗する（Max number of allowed reports already running）。
 *   上限は契約で違うので、確実に通る本数まで絞ってから少しずつ流す。
 */
export const REPORT_MAX_RUNNING = 2;
/** 上限に当たった分をやり直す回数（他の実行分が走り終わるのを待つため）。 */
export const REPORT_MAX_RETRY = 5;
/** レポート全体の打ち切り時間（分）。少しずつ流すぶん、一括より時間がかかる。 */
export const REPORT_DEADLINE_MIN = 60;

/** 「同時実行数の上限に当たった」＝待てば通る失敗か。 */
export function isReportBusy(message: string): boolean {
  return /already running|try again later/i.test(message ?? '');
}
