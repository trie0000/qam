import { describe, it, expect } from 'vitest';
import { parseTicketXml, parseTicketPages, ticketSince, ticketQuery, resolveTicketMode, mergeTicketSets } from '../src/tickets';
import type { QamTicket } from '../src/types';

// ticket_list_output.dtd に沿った最小の応答。
const page = (tickets: string, truncLast?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><REMEDIATION_TICKETS>
  <HEADER><USER_LOGIN>u</USER_LOGIN><COMPANY>c</COMPANY><DATETIME>2026-08-16T00:00:00Z</DATETIME><WHERE/></HEADER>
  <TICKET_LIST>${tickets}</TICKET_LIST>
  ${truncLast ? `<TRUNCATION last="${truncLast}">Truncated after 1000 records</TRUNCATION>` : ''}
  </REMEDIATION_TICKETS>`;

const ticket = (no: string, state: string, ip: string, hostId?: string, fqdn?: string): string =>
  `<TICKET><NUMBER>${no}</NUMBER><CREATION_DATETIME>2026-08-01T09:30:00Z</CREATION_DATETIME>
   <DUE_DATETIME>2026-09-01T09:30:00Z</DUE_DATETIME><CURRENT_STATE>${state}</CURRENT_STATE>
   <ASSIGNEE><NAME>n</NAME><EMAIL>e</EMAIL><LOGIN>l</LOGIN></ASSIGNEE>
   <DETECTION><IP>${ip}</IP>${hostId ? `<HOST_ID>${hostId}</HOST_ID>` : ''}
   <DNSNAME>dns.example</DNSNAME>${fqdn ? `<FQDN>${fqdn}</FQDN>` : ''}</DETECTION></TICKET>`;

// show_vuln_details=1 のときだけ返る部分。脆弱性種別の判定に使う。
const withVuln = (cves: string[]): string =>
  `<TICKET><NUMBER>201</NUMBER><CURRENT_STATE>OPEN</CURRENT_STATE><DETECTION><IP>10.0.0.9</IP></DETECTION>
   <VULNINFO><TITLE>t</TITLE><QID>1</QID><SEVERITY>3</SEVERITY>
   <CVE_ID_LIST>${cves.map((c) => `<CVE_ID><ID>${c}</ID><URL>u</URL></CVE_ID>`).join('')}</CVE_ID_LIST>
   </VULNINFO></TICKET>`;

describe('チケット応答の解析', () => {
  it('TICKET から ID/状態/ホストID/IP/FQDN/起票日時を取り出す', () => {
    const t = parseTicketXml(page(ticket('101', 'OPEN', '10.0.0.1', '9001', 'host1.example')))[0];
    expect(t).toEqual({
      number: '101', state: 'OPEN', hostId: '9001', ip: '10.0.0.1',
      fqdn: 'host1.example', created: '2026-08-01T09:30:00Z', firstFound: '', lastFound: '', cves: [],
    });
  });

  it('FQDN が無い応答では DNSNAME で代替する', () => {
    expect(parseTicketXml(page(ticket('102', 'CLOSED', '10.0.0.2')))[0].fqdn).toBe('dns.example');
  });

  it('show_host_id が効かず HOST_ID が無くても落ちない（空文字）', () => {
    expect(parseTicketXml(page(ticket('103', 'RESOLVED', '10.0.0.3')))[0].hostId).toBe('');
  });

  it('VULNINFO から CVE 番号を取り出す', () => {
    expect(parseTicketXml(page(withVuln(['CVE-2024-1111', 'CVE-2024-2222'])))[0].cves)
      .toEqual(['CVE-2024-1111', 'CVE-2024-2222']);
  });

  it('CVE が付かない応答でも空配列（種別の判定で落ちない）', () => {
    expect(parseTicketXml(page(ticket('104', 'OPEN', '10.0.0.4')))[0].cves).toEqual([]);
  });

  it('同じ CVE が重複していても1つにする', () => {
    expect(parseTicketXml(page(withVuln(['CVE-2024-1111', 'cve-2024-1111'])))[0].cves).toEqual(['CVE-2024-1111']);
  });

  it('空応答で例外を投げない（取込全体を巻き込まない）', () => {
    expect(parseTicketXml('')).toEqual([]);
  });

  it('HTTP 200 + <ERROR> は 0 件で通さず失敗にする', () => {
    // 0 件として保存すると「この期間はチケット無し」と区別が付かなくなるため。
    expect(() => parseTicketPages(['<REMEDIATION_TICKETS><ERROR number="999">not authorized</ERROR></REMEDIATION_TICKETS>']))
      .toThrow(/not authorized/);
  });

  it('正常な 0 件応答（TICKET_LIST 無し）はエラーにしない', () => {
    expect(parseTicketPages([page('')])).toEqual([]);
  });

  it('複数ページを結合し、境界の重複チケットは1件にまとめる', () => {
    // 1,000件打ち切りの続きは since_ticket_number=last+1 で取るが、
    // 実装/仕様のずれで同じ番号が再度返ることがあるため重複排除する。
    const p1 = page(ticket('200', 'OPEN', '10.0.0.4') + ticket('201', 'OPEN', '10.0.0.5'), '201');
    const p2 = page(ticket('201', 'CLOSED', '10.0.0.5') + ticket('202', 'OPEN', '10.0.0.6'));
    const rows = parseTicketPages([p1, p2]);
    expect(rows.map((r) => r.number)).toEqual(['202', '201', '200']); // 新しい順
    expect(rows.find((r) => r.number === '201')?.state).toBe('CLOSED'); // 後のページが勝つ
  });
});

describe('取得期間（modified_since_datetime）', () => {
  it('Qualys の形式 YYYY-MM-DDTHH:MM:SSZ（ミリ秒なし）で 1ヶ月前を返す', () => {
    expect(ticketSince(new Date('2026-08-16T12:34:56.789Z'))).toBe('2026-07-16T12:34:56Z');
  });

  it('年をまたぐ場合も 1ヶ月前になる', () => {
    expect(ticketSince(new Date('2026-01-10T00:00:00Z'))).toBe('2025-12-10T00:00:00Z');
  });
});

describe('取得範囲の決定', () => {
  it('取込実績が無ければ、変化分を要求されても全件に落とす', () => {
    // 変化分だけを保存すると、期間内に動きの無かったオープン中チケットが一覧から欠ける。
    expect(resolveTicketMode('delta', false)).toBe('open');
    expect(resolveTicketMode('open', false)).toBe('open');
  });

  it('取込実績があれば要求どおり', () => {
    expect(resolveTicketMode('delta', true)).toBe('delta');
    expect(resolveTicketMode('open', true)).toBe('open');
  });

  it('全件モードは states=OPEN のみで期間を付けない', () => {
    expect(ticketQuery('open')).toEqual({ mode: 'open', since: '', states: 'OPEN' });
  });

  it('変化分モードはクローズ済みも含めた4状態を対象にする', () => {
    // オープン→クローズの動きを拾うため、OPEN だけでは足りない。
    const q = ticketQuery('delta', new Date('2026-08-16T00:00:00Z'));
    expect(q.states).toBe('OPEN,RESOLVED,CLOSED,IGNORED');
    expect(q.since).toBe('2026-07-16T00:00:00Z');
  });
});

describe('delta とオープン中の取得をまとめる', () => {
  const t = (n: string, state: string, lastFound = ''): QamTicket =>
    ({ number: n, state, hostId: '', ip: '10.0.0.1', fqdn: '', created: '', firstFound: '', lastFound, cves: [] });

  it('★動きの無いオープン中チケットを拾う（delta だけでは1件も返らない）', () => {
    // modified_since_datetime は「変更のあったチケット」しか返さないので、
    // 再検知しかしていないオープン中チケットは最終検知日が古いまま固まる。
    const delta = [t('1', 'CLOSED', '2026-08-01 00:00:00')];
    const open = [t('2', 'OPEN', '2026-08-17 00:00:00')];
    expect(mergeTicketSets(delta, open).map((x) => x.number)).toEqual(['1', '2']);
  });

  it('両方に出てくるチケットは1件にする', () => {
    const merged = mergeTicketSets([t('1', 'OPEN', '古い')], [t('1', 'OPEN', '新しい')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].lastFound).toBe('新しい'); // あとから渡した方が残る
  });

  it('片方が取れなくても落ちない（変化分だけで更新できる）', () => {
    expect(mergeTicketSets([t('1', 'OPEN')], undefined).map((x) => x.number)).toEqual(['1']);
    expect(mergeTicketSets(undefined, undefined)).toEqual([]);
  });
});
