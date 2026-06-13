import { describe, it, expect } from 'vitest';
import { parseQualysXml, resolveSnapshotDate } from '../src/ingest/parse';
import { compareSnapshots, shrinkGuard, countByChange } from '../src/diff';

const GROUP1 = `<?xml version="1.0" encoding="UTF-8" ?>
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><DATETIME>2026-06-12T00:00:00Z</DATETIME><ASSET_GROUP_LIST>
  <ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>1</OWNER_ID>
    <IP_SET><IP>10.0.0.1</IP><IP_RANGE>10.0.0.0-10.0.0.5</IP_RANGE></IP_SET>
    <DNS_LIST><DNS>a.example</DNS></DNS_LIST></ASSET_GROUP>
  <ASSET_GROUP><ID>200</ID><TITLE><![CDATA[Stage]]></TITLE><OWNER_ID>1</OWNER_ID>
    <IP_SET><IP>10.0.1.1</IP></IP_SET></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;

const GROUP2 = `<?xml version="1.0" encoding="UTF-8" ?>
<ASSET_GROUP_LIST_OUTPUT><RESPONSE><ASSET_GROUP_LIST>
  <ASSET_GROUP><ID>100</ID><TITLE><![CDATA[Prod]]></TITLE><OWNER_ID>2</OWNER_ID>
    <IP_SET><IP>10.0.0.1</IP><IP_RANGE>10.0.0.0-10.0.0.5</IP_RANGE><IP>10.0.0.9</IP></IP_SET>
    <DNS_LIST><DNS>a.example</DNS><DNS>b.example</DNS></DNS_LIST></ASSET_GROUP>
  <ASSET_GROUP><ID>300</ID><TITLE><![CDATA[NewGrp]]></TITLE><OWNER_ID>1</OWNER_ID>
    <IP_SET><IP>10.0.2.1</IP></IP_SET></ASSET_GROUP>
</ASSET_GROUP_LIST></RESPONSE></ASSET_GROUP_LIST_OUTPUT>`;

const HOST1 = `<HOST_LIST_OUTPUT><RESPONSE><HOST_LIST>
  <HOST><ID>1</ID><IP>10.0.0.1</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web01.example</FQDN></DNS_DATA><OS><![CDATA[Linux 3]]></OS></HOST>
  <HOST><ID>2</ID><IP>10.0.0.2</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web02.example</FQDN></DNS_DATA><OS><![CDATA[Linux 3]]></OS></HOST>
</HOST_LIST></RESPONSE></HOST_LIST_OUTPUT>`;

const HOST2 = `<HOST_LIST_OUTPUT><RESPONSE><HOST_LIST>
  <HOST><ID>1</ID><IP>10.0.0.1</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web01.example</FQDN></DNS_DATA><OS><![CDATA[Windows]]></OS></HOST>
  <HOST><ID>3</ID><IP>10.0.0.3</IP><TRACKING_METHOD>IP</TRACKING_METHOD>
    <DNS_DATA><FQDN>web03.example</FQDN></DNS_DATA><OS><![CDATA[Linux 3]]></OS></HOST>
</HOST_LIST></RESPONSE></HOST_LIST_OUTPUT>`;

const DOMAIN1 = `<DOMAIN_LIST>
  <DOMAIN><DOMAIN_NAME>example.com</DOMAIN_NAME><DOMAIN_ID>10</DOMAIN_ID>
    <NETBLOCK><RANGE><START>10.0.0.0</START><END>10.0.0.255</END></RANGE></NETBLOCK></DOMAIN>
</DOMAIN_LIST>`;

const DOMAIN2 = `<DOMAIN_LIST>
  <DOMAIN><DOMAIN_NAME>example.com</DOMAIN_NAME><DOMAIN_ID>10</DOMAIN_ID>
    <NETBLOCK><RANGE><START>10.0.0.0</START><END>10.0.0.255</END></RANGE>
             <RANGE><START>10.0.1.0</START><END>10.0.1.255</END></RANGE></NETBLOCK></DOMAIN>
  <DOMAIN><DOMAIN_NAME>new.example</DOMAIN_NAME><DOMAIN_ID>11</DOMAIN_ID></DOMAIN>
</DOMAIN_LIST>`;

describe('parse', () => {
  it('group: entity 自動判定 / IPS=IP+IP_RANGE / DNS_LIST', () => {
    const s = parseQualysXml(GROUP1);
    expect(s.entity).toBe('group');
    expect(s.records['100'].set.IPS.length).toBe(2);
    expect(s.records['100'].set.DNS_LIST.join(',')).toBe('a.example');
    expect(resolveSnapshotDate(s.datetime, '2099-01-01')).toBe('2026-06-12');
  });
  it('host: entity 自動判定 / name=FQDN', () => {
    const s = parseQualysXml(HOST1);
    expect(s.entity).toBe('host');
    expect(s.records['1'].name).toBe('web01.example');
  });
  it('domain: entity 自動判定 / NETBLOCK', () => {
    const s = parseQualysXml(DOMAIN1);
    expect(s.entity).toBe('domain');
    expect(s.records['example.com'].set.NETBLOCK[0]).toBe('10.0.0.0-10.0.0.255');
  });
});

describe('diff', () => {
  it('group: added/deleted/modified と IPS added', () => {
    const a = parseQualysXml(GROUP1).records;
    const b = parseQualysXml(GROUP2).records;
    const ev = compareSnapshots(a, b, 'group', '2026-06-13');
    expect(countByChange(ev, 'added')).toBe(1);
    expect(countByChange(ev, 'deleted')).toBe(1);
    expect(countByChange(ev, 'modified')).toBe(3);
    const ips = ev.find((e) => e.field === 'IPS')!;
    expect(ips.added).toEqual(['10.0.0.9']);
    expect(ips.removed).toEqual([]);
  });
  it('host: OS 変更', () => {
    const ev = compareSnapshots(parseQualysXml(HOST1).records, parseQualysXml(HOST2).records, 'host', '2026-06-13');
    expect(countByChange(ev, 'added')).toBe(1);
    expect(countByChange(ev, 'deleted')).toBe(1);
    expect(countByChange(ev, 'modified')).toBe(1);
    expect(ev.find((e) => e.field === 'OS')!.new).toBe('Windows');
  });
  it('domain: NETBLOCK 追加', () => {
    const ev = compareSnapshots(parseQualysXml(DOMAIN1).records, parseQualysXml(DOMAIN2).records, 'domain', '2026-06-13');
    expect(countByChange(ev, 'added')).toBe(1);
    expect(countByChange(ev, 'modified')).toBe(1);
    expect(ev.find((e) => e.field === 'NETBLOCK')!.added).toEqual(['10.0.1.0-10.0.1.255']);
  });
});

const USER1 = `<USER_LIST_OUTPUT><USER_LIST>
  <USER><USER_LOGIN>acme_ab1</USER_LOGIN><USER_ID>63</USER_ID>
    <CONTACT_INFO><FIRSTNAME><![CDATA[Alex]]></FIRSTNAME><LASTNAME><![CDATA[Kim]]></LASTNAME><EMAIL><![CDATA[a@example.com]]></EMAIL></CONTACT_INFO>
    <USER_STATUS>Active</USER_STATUS><USER_ROLE>Manager</USER_ROLE></USER>
</USER_LIST></USER_LIST_OUTPUT>`;
const USER2 = `<USER_LIST_OUTPUT><USER_LIST>
  <USER><USER_LOGIN>acme_ab1</USER_LOGIN><USER_ID>63</USER_ID>
    <CONTACT_INFO><FIRSTNAME><![CDATA[Alex]]></FIRSTNAME><LASTNAME><![CDATA[Kim]]></LASTNAME><EMAIL><![CDATA[a@example.com]]></EMAIL></CONTACT_INFO>
    <USER_STATUS>Active</USER_STATUS><USER_ROLE>Reader</USER_ROLE></USER>
  <USER><USER_LOGIN>acme_cd2</USER_LOGIN><USER_ID>64</USER_ID>
    <CONTACT_INFO><FIRSTNAME><![CDATA[Bo]]></FIRSTNAME><LASTNAME><![CDATA[Lee]]></LASTNAME></CONTACT_INFO>
    <USER_STATUS>Active</USER_STATUS><USER_ROLE>Scanner</USER_ROLE></USER>
</USER_LIST></USER_LIST_OUTPUT>`;

describe('user', () => {
  it('parse: entity=user / key=USER_ID / 役割など', () => {
    const s = parseQualysXml(USER1);
    expect(s.entity).toBe('user');
    expect(s.records['63'].name).toBe('acme_ab1');
    expect(s.records['63'].scalar.NAME).toBe('Kim Alex');
    expect(s.records['63'].scalar.USER_ROLE).toBe('Manager');
  });
  it('diff: ロール変更と追加ユーザ', () => {
    const ev = compareSnapshots(parseQualysXml(USER1).records, parseQualysXml(USER2).records, 'user', '2026-06-14T08-00-00');
    expect(countByChange(ev, 'modified')).toBe(1); // USER_ROLE
    expect(countByChange(ev, 'added')).toBe(1);     // 64
    expect(ev.find((e) => e.field === 'USER_ROLE')!.new).toBe('Reader');
  });
  it('parse: MSP user_list.php（USER_ID なし）は USER_LOGIN をキーにする', () => {
    const msp = `<USER_LIST_OUTPUT><USER_LIST>
      <USER><USER_LOGIN>acme_zz9</USER_LOGIN>
       <CONTACT_INFO><FIRSTNAME>Lee</FIRSTNAME><LASTNAME>Park</LASTNAME><EMAIL>z@e.x</EMAIL></CONTACT_INFO>
       <USER_STATUS>Active</USER_STATUS><USER_ROLE>Reader</USER_ROLE></USER>
    </USER_LIST></USER_LIST_OUTPUT>`;
    const s = parseQualysXml(msp);
    expect(s.entity).toBe('user');
    expect(s.records['acme_zz9'].name).toBe('acme_zz9');
    expect(s.records['acme_zz9'].scalar.NAME).toBe('Park Lee');
  });
});

describe('shrinkGuard', () => {
  it('cases', () => {
    expect(shrinkGuard(100, 40, 0.5)).toBe(true);
    expect(shrinkGuard(100, 80, 0.5)).toBe(false);
    expect(shrinkGuard(100, 0, 0.5)).toBe(true);
    expect(shrinkGuard(0, 0, 0.5)).toBe(false);
  });
});
