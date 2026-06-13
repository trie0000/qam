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

describe('shrinkGuard', () => {
  it('cases', () => {
    expect(shrinkGuard(100, 40, 0.5)).toBe(true);
    expect(shrinkGuard(100, 80, 0.5)).toBe(false);
    expect(shrinkGuard(100, 0, 0.5)).toBe(true);
    expect(shrinkGuard(0, 0, 0.5)).toBe(false);
  });
});
