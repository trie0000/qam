import { describe, it, expect } from 'vitest';
import { buildCompanyMails, groupByCompany, ticketsWithoutCompany, openTickets, normalizeTemplates } from '../src/ras-mail';
import { normalizeRasPerms } from '../src/ras';
import type { RasTicket } from '../src/ras';
import type { Contact } from '../src/contacts';

const t = (n: string, company: string, state = 'OPEN', ip = '10.0.0.1'): RasTicket =>
  ({ number: n, state, hostId: 'h1', ip, fqdn: 'a.example', settenId: 'R100',
     businessCompany: company, managementCompany: '', created: '', firstFound: '', lastFound: '',
     port: '', vulnKind: 'OS・ミドルウェア検査牽制分', cveIds: '' });

const perms = normalizeRasPerms({
  byBusinessCompany: { 'A事業会社': [7], 'B事業会社': [] },
  contactNameByCompany: { 'A事業会社': 'A社' },
});
const contacts = new Map<string, Contact[]>([
  ['A社', [{ scope: 'A社', dept: 'IT統括部', name: '山田 太郎', email: 'taro@example.com' }]],
]);
const tpl = { subject: '【{{company}}】脆弱性のご連絡（{{count}}件）', body: '{{greeting}}\n\n{{tickets}}\n\n{{listLink}}' };

describe('事業会社ごとのメール', () => {
  it('複数の脆弱性があっても1事業会社1通にまとめる', () => {
    // ★会社ごとに何通も届くと受け取る側が処理しきれない。
    const mails = buildCompanyMails({
      tickets: [t('1', 'A事業会社'), t('2', 'A事業会社'), t('3', 'A事業会社')],
      perms, contacts, template: tpl, listUrl: 'https://sp/list',
    });
    expect(mails).toHaveLength(1);
    expect(mails[0].tickets).toHaveLength(3);
    expect(mails[0].draft!.subject).toBe('【A事業会社】脆弱性のご連絡（3件）');
  });

  it('宛先は体制表の対応付けで引く', () => {
    const m = buildCompanyMails({ tickets: [t('1', 'A事業会社')], perms, contacts, template: tpl, listUrl: '' })[0];
    expect(m.contactName).toBe('A社');
    expect(m.draft!.to).toBe('taro@example.com');
  });

  it('本文は「〈事業会社名〉事業場ITセキュリティ責任者 〈氏名〉様」から始まる', () => {
    const m = buildCompanyMails({ tickets: [t('1', 'A事業会社')], perms, contacts, template: tpl, listUrl: '' })[0];
    expect(m.draft!.body.startsWith('A事業会社 事業場ITセキュリティ責任者 山田 太郎 様')).toBe(true);
  });

  it('本文に脆弱性の一覧と SharePoint へのリンクが入る', () => {
    const m = buildCompanyMails({ tickets: [t('1', 'A事業会社')], perms, contacts, template: tpl, listUrl: 'https://sp/list' })[0];
    expect(m.draft!.body).toContain('#1 OPEN 10.0.0.1');
    expect(m.draft!.body).toContain('https://sp/list'); // テキストなので URL をそのまま入れる
  });

  it('体制表に連絡先が無い会社は作らず、理由を返す', () => {
    // ★宛先の無い下書きを開いても意味がない。
    const m = buildCompanyMails({ tickets: [t('1', 'B事業会社')], perms, contacts, template: tpl, listUrl: '' })[0];
    expect(m.draft).toBeUndefined();
    expect(m.error).toMatch(/B事業会社/);
  });

  it('事業会社が未設定のチケットは宛先が決まらないので数えて返す', () => {
    const list = [t('1', ''), t('2', 'A事業会社')];
    expect(groupByCompany(list).size).toBe(1);
    expect(ticketsWithoutCompany(list).map((x) => x.number)).toEqual(['1']);
  });

  it('月次の対象はオープン中のチケットだけ', () => {
    expect(openTickets([t('1', 'A事業会社', 'OPEN'), t('2', 'A事業会社', 'CLOSED')]).map((x) => x.number)).toEqual(['1']);
  });

  it('テンプレートは壊れた保存値でも既定に整う', () => {
    expect(normalizeTemplates(null).adhoc.subject).toBe('');
    expect(normalizeTemplates({ monthly: { subject: 'x' } }).monthly.subject).toBe('x');
  });
});
