// 独自RAS の連絡メール。宛先の決定と本文の差し込みだけを持つ（送信はしない）。
//
// ★1 事業会社につき 1 通。脆弱性が複数あってもまとめる。会社ごとに何通も届くと
//   受け取る側が処理しきれない。
import { buildDraft, type MailDraft, type MailTemplate, type MailVars } from './mail';
import { contactNameFor, greetingFor, type RasPerms, type RasTicket } from './ras';
import type { Contact } from './contacts';

export interface MailTemplates {
  /** 脆弱性を検知したときに都度送るもの。 */
  adhoc: MailTemplate;
  /** 月次でオープン中のチケットがある会社へ送るもの。 */
  monthly: MailTemplate;
}

export const EMPTY_TEMPLATES: MailTemplates = {
  adhoc: { subject: '', body: '', cc: '', replyTo: '' },
  monthly: { subject: '', body: '', cc: '', replyTo: '' },
};

export function normalizeTemplates(v: unknown): MailTemplates {
  const o = (v ?? {}) as Record<string, unknown>;
  const one = (x: unknown): MailTemplate => {
    const t = (x ?? {}) as Record<string, unknown>;
    return {
      subject: String(t.subject ?? ''), body: String(t.body ?? ''),
      cc: String(t.cc ?? ''), replyTo: String(t.replyTo ?? ''),
    };
  };
  return { adhoc: one(o.adhoc), monthly: one(o.monthly) };
}

export interface CompanyMail {
  company: string;
  /** 体制表での表記（宛先を引くのに使った名前）。 */
  contactName: string;
  tickets: RasTicket[];
  draft?: MailDraft;
  /** 作れなかった理由（宛先が見つからない等）。 */
  error?: string;
}

/** チケットを事業会社ごとにまとめる。事業会社が未設定のものは宛先が決まらない。 */
export function groupByCompany(tickets: RasTicket[]): Map<string, RasTicket[]> {
  const m = new Map<string, RasTicket[]>();
  for (const t of tickets) {
    const c = (t.businessCompany ?? '').trim();
    if (!c) continue;
    const cur = m.get(c) ?? [];
    cur.push(t);
    m.set(c, cur);
  }
  return m;
}

/** 事業会社が未設定で宛先を決められないチケット。 */
export const ticketsWithoutCompany = (tickets: RasTicket[]): RasTicket[] =>
  tickets.filter((t) => !(t.businessCompany ?? '').trim());

/** 本文に入れる脆弱性の一覧。 */
export const ticketLines = (tickets: RasTicket[]): string =>
  tickets.map((t) => `・#${t.number} ${t.state} ${t.ip}${t.fqdn ? ` (${t.fqdn})` : ''}`).join('\n');

export interface BuildMailsInput {
  tickets: RasTicket[];
  perms: RasPerms;
  /** 体制表の「管轄範囲」→ 連絡先。 */
  contacts: Map<string, Contact[]>;
  template: MailTemplate;
  /** SharePoint のチケット一覧の URL（本文に入れる）。 */
  listUrl: string;
}

/**
 * 事業会社ごとに下書きを 1 通ずつ組み立てる。
 * ★宛先が引けない会社は作らず、理由を返す。宛先の無い下書きを開いても意味がない。
 */
export function buildCompanyMails(input: BuildMailsInput): CompanyMail[] {
  const out: CompanyMail[] = [];
  for (const [company, tickets] of groupByCompany(input.tickets)) {
    const contactName = contactNameFor(company, input.perms);
    const list = input.contacts.get(contactName) ?? [];
    if (!list.length) {
      out.push({ company, contactName, tickets, error: `体制表に「${contactName}」の連絡先がありません（マスター管理で対応付けを確認してください）` });
      continue;
    }
    const vars: MailVars = {
      company,
      name: list.map((c) => c.name).join('、'),
      dept: list[0].dept,
      greeting: greetingFor(company, list.map((c) => c.name).join('、')),
      count: String(tickets.length),
      tickets: ticketLines(tickets),
    };
    out.push({
      company, contactName, tickets,
      draft: buildDraft(list.map((c) => c.email), input.template, { ...vars, listLink: input.listUrl }),
    });
  }
  return out.sort((a, b) => a.company.localeCompare(b.company, 'ja'));
}

/** 月次の対象＝オープン中のチケットがある会社。 */
export const openTickets = (tickets: RasTicket[]): RasTicket[] =>
  tickets.filter((t) => (t.state ?? '').trim().toUpperCase() === 'OPEN');
