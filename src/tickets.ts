// 修復チケット（Qualys Remediation Ticket）の期間指定取得と解析。
//
// API: GET /msp/ticket_list.php （v1/MSP。v2 には存在しない）
//   - 期間で絞れるのは modified_since_datetime だけ。「起票日で絞る」パラメータは無い。
//     起票もチケット履歴(HISTORY)の1件として記録されるので、modified_since_datetime に
//     1ヶ月前を渡せば「その期間に起票された」ものも「状態が変わった(OPEN→CLOSEDなど)」ものも入る。
//   - states を明示しないと OPEN だけになるため、4状態すべてを指定する（クローズ済みも見たい）。
//   - show_host_id=1 でないと DETECTION/HOST_ID が出ない。
//   - 1 リクエスト 1,000 件が上限。超過時は <TRUNCATION last="N"> が返るので
//     since_ticket_number=N+1 で続きを取る（次ページURLは返らない＝relay 側で組み立てる）。
import type { QamTicket } from './types';

// 取得範囲。delta=直近1ヶ月に起票/状態変更があった分、open=現時点でオープン中を全件。
// ★delta は「差分」なので、これだけを保存すると期間内に動きの無かったオープン中チケットが
//   一覧から欠ける。初回は必ず open を取る（呼び出し側で強制している）。
export type TicketMode = 'delta' | 'open';
export interface TicketQuery { mode: TicketMode; since: string; states: string }
// 実際に使う取得範囲を決める。取込実績が無いときは要求に関わらず open に落とす。
// ★ここを守らないと、初回に「変化分」だけを保存してしまい、期間内に動きの無かった
//   オープン中チケットが一覧から丸ごと欠ける（0件と区別が付かない）。
export const resolveTicketMode = (requested: TicketMode, hasHistory: boolean): TicketMode =>
  (hasHistory ? requested : 'open');

export const ticketQuery = (mode: TicketMode, now = new Date()): TicketQuery =>
  (mode === 'open'
    ? { mode, since: '', states: 'OPEN' }
    : { mode, since: ticketSince(now), states: 'OPEN,RESOLVED,CLOSED,IGNORED' });

// Qualys の日時パラメータ形式 'YYYY-MM-DDTHH:MM:SSZ'（UTC・ミリ秒なし）。
export const ticketSince = (now: Date, months = 1): string => {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const text = (el: Element | null, tag: string): string => {
  if (!el) return '';
  const n = el.getElementsByTagName(tag)[0];
  return n ? (n.textContent ?? '').trim() : '';
};

// ticket_list_output: REMEDIATION_TICKETS > TICKET_LIST > TICKET+
// FQDN は DETECTION/FQDN。古い応答では入らないことがあるので DNSNAME で補う。
export function parseTicketXml(xml: string): QamTicket[] {
  if (!xml.trim()) return [];
  let doc: Document;
  // 空応答/HTML(WAF)など XML でないものが返ることがある。ここで落ちると取込全体が止まるので握る。
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return []; }
  const out: QamTicket[] = [];
  for (const t of Array.from(doc.getElementsByTagName('TICKET'))) {
    const det = t.getElementsByTagName('DETECTION')[0] ?? null;
    // STATS に初回/最終の検知日時が入る（無い契約もあるので空を許す）。
    const stats = t.getElementsByTagName('STATS')[0] ?? null;
    // VULNINFO > CVE_ID_LIST > CVE_ID+（show_vuln_details=1 のときだけ返る）。
    // ★CVE_ID は (ID, URL) の親要素。textContent を取ると URL まで繋がる（実際に踏んだ）。
    const cves = Array.from(t.getElementsByTagName('CVE_ID'))
      .map((n) => (n.getElementsByTagName('ID')[0]?.textContent ?? n.textContent ?? '').trim().toUpperCase())
      .filter(Boolean);
    const num = text(t, 'NUMBER');
    if (!num) continue;
    out.push({
      number: num,
      state: text(t, 'CURRENT_STATE'),
      hostId: text(det, 'HOST_ID'),
      ip: text(det, 'IP'),
      fqdn: text(det, 'FQDN') || text(det, 'DNSNAME'),
      port: text(det, 'PORT'),
      created: text(t, 'CREATION_DATETIME'),
      firstFound: text(stats, 'FIRST_FOUND_DATETIME'),
      lastFound: text(stats, 'LAST_FOUND_DATETIME'),
      cves: [...new Set(cves)],
    });
  }
  return out;
}

// 複数ページ（PAGE_SEP 連結）をまとめて解析。チケットIDで重複排除する
// （ページ境界の since_ticket_number は同じ番号を再取得し得る）。
export function parseTicketPages(pages: string[]): QamTicket[] {
  const byNo = new Map<string, QamTicket>();
  for (const p of pages) {
    if (!p.trim()) continue;
    const rows = parseTicketXml(p);
    // Qualys は権限不足などを HTTP 200 + <ERROR> で返す。0 件として保存すると
    // 「この期間はチケット無し」と区別が付かないので、ここで失敗として扱う。
    if (!rows.length) {
      const err = /<ERROR[^>]*>([\s\S]*?)<\/ERROR>/.exec(p);
      if (err) throw new Error(`Qualys がエラーを返しました: ${err[1].trim()}`);
    }
    for (const t of rows) byNo.set(t.number, t);
  }
  // チケットIDは数値。新しい順（大きい順）に並べる。
  return [...byNo.values()].sort((a, b) => Number(b.number) - Number(a.number));
}

/**
 * 2回ぶんの取得結果を1本にまとめる（チケット番号で重複排除）。
 * ★日次更新は delta（modified_since_datetime）だけでは足りない。動きの無いオープン中
 *   チケットが1件も返らず、最終検知日が古いままになる。states=OPEN の取得と混ぜる。
 *   同じ番号があとから来たら上書きする（どちらも同時点の取得なので中身は同じ）。
 */
export function mergeTicketSets(...sets: (QamTicket[] | undefined)[]): QamTicket[] {
  const byNo = new Map<string, QamTicket>();
  for (const list of sets) for (const t of list ?? []) byNo.set(t.number, t);
  return [...byNo.values()];
}
