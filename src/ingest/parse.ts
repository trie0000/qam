// Qualys 一覧 XML → 正規化レコード。構造の正典は docs/QUALYS_XML.md。
// ブラウザ/vitest(happy-dom) の DOMParser を使う。
import type { QamEntity, QamRecord, QamRecords, QamSnapshot } from '../types';

// 変更検知用の安定ハッシュ（暗号強度不要・FNV-1a 32bit hex）。
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashRecord(r: QamRecord): string {
  const parts: string[] = [];
  for (const k of Object.keys(r.scalar).sort()) parts.push(`${k}=${r.scalar[k]}`);
  for (const k of Object.keys(r.set).sort()) parts.push(`${k}=[${[...r.set[k]].sort().join(',')}]`);
  return fnv1a(parts.join('|'));
}

function text(el: Element | null, tag: string): string {
  if (!el) return '';
  const n = el.getElementsByTagName(tag)[0];
  return n ? (n.textContent ?? '').trim() : '';
}

function tagValues(parent: Element | null, tag: string): string[] {
  if (!parent) return [];
  return Array.from(parent.getElementsByTagName(tag))
    .map((n) => (n.textContent ?? '').trim())
    .filter((v) => v !== '');
}

function listValues(el: Element, listTag: string, itemTag: string): string[] {
  const list = el.getElementsByTagName(listTag)[0];
  return list ? tagValues(list, itemTag) : [];
}

function csvValues(el: Element, tag: string): string[] {
  return text(el, tag)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const uniq = (a: string[]): string[] => Array.from(new Set(a)).sort();

function newRecord(): QamRecord {
  return { key: '', name: '', scalar: {}, set: {}, info: {}, hash: '' };
}

function entityFromRoot(root: string): QamEntity | null {
  switch (root) {
    case 'ASSET_GROUP_LIST_OUTPUT': return 'group';
    case 'HOST_LIST_OUTPUT': return 'host';
    case 'DOMAIN_LIST_OUTPUT':
    case 'DOMAIN_LIST': return 'domain';
    default: return null;
  }
}

function readGroup(ag: Element): QamRecord {
  const r = newRecord();
  r.key = text(ag, 'ID');
  r.name = text(ag, 'TITLE');
  r.scalar.TITLE = r.name;
  r.scalar.OWNER_ID = text(ag, 'OWNER_ID');
  r.scalar.BUSINESS_IMPACT = text(ag, 'BUSINESS_IMPACT');
  r.info.LAST_UPDATE = text(ag, 'LAST_UPDATE');
  const ipset = ag.getElementsByTagName('IP_SET')[0] ?? null;
  r.set.IPS = uniq([...tagValues(ipset, 'IP'), ...tagValues(ipset, 'IP_RANGE')]);
  r.set.DNS_LIST = uniq(listValues(ag, 'DNS_LIST', 'DNS'));
  r.set.NETBIOS_LIST = uniq(listValues(ag, 'NETBIOS_LIST', 'NETBIOS'));
  r.set.DOMAIN_LIST = uniq(listValues(ag, 'DOMAIN_LIST', 'DOMAIN'));
  r.set.HOST_IDS = uniq(csvValues(ag, 'HOST_IDS'));
  return r;
}

function readHost(h: Element): QamRecord {
  const r = newRecord();
  r.key = text(h, 'ID');
  const dd = h.getElementsByTagName('DNS_DATA')[0] ?? null;
  const fqdn = dd ? text(dd, 'FQDN') : '';
  const dns = text(h, 'DNS');
  const ip = text(h, 'IP');
  r.scalar.IP = ip;
  r.scalar.FQDN = fqdn;
  r.scalar.DNS = dns;
  r.scalar.NETBIOS = text(h, 'NETBIOS');
  r.scalar.OS = text(h, 'OS');
  r.scalar.TRACKING_METHOD = text(h, 'TRACKING_METHOD');
  r.info.LAST_VULN_SCAN_DATETIME = text(h, 'LAST_VULN_SCAN_DATETIME');
  r.info.FIRST_FOUND_DATE = text(h, 'FIRST_FOUND_DATE');
  r.name = fqdn || dns || ip;
  return r;
}

function readDomain(d: Element): QamRecord {
  const r = newRecord();
  let name = text(d, 'DOMAIN_NAME');
  if (!name && d.getElementsByTagName('*').length === 0) name = (d.textContent ?? '').trim();
  r.key = name;
  r.name = name;
  r.scalar.DOMAIN_ID = text(d, 'DOMAIN_ID');
  const net = d.getElementsByTagName('NETWORK')[0] ?? null;
  r.scalar.NETWORK_NAME = net ? text(net, 'NETWORK_NAME') : '';
  const nb = d.getElementsByTagName('NETBLOCK')[0] ?? null;
  const blocks = nb
    ? Array.from(nb.getElementsByTagName('RANGE')).map((rg) => `${text(rg, 'START')}-${text(rg, 'END')}`)
    : [];
  r.set.NETBLOCK = uniq(blocks.filter((b) => b !== '-'));
  return r;
}

export function parseQualysXml(xml: string, entity?: QamEntity): QamSnapshot {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root) throw new Error('XML を解析できませんでした');
  const rootName = root.nodeName;
  if (rootName.toLowerCase() === 'parsererror' || root.getElementsByTagName('parsererror').length) {
    throw new Error('XML を解析できませんでした');
  }
  const ent = entity ?? entityFromRoot(rootName);
  if (!ent) throw new Error(`未知の XML ルート要素です: ${root.nodeName}`);

  const records: QamRecords = {};
  const add = (r: QamRecord) => {
    if (!r.key) return;
    r.hash = hashRecord(r);
    records[r.key] = r;
  };
  if (ent === 'group') Array.from(doc.getElementsByTagName('ASSET_GROUP')).forEach((n) => add(readGroup(n)));
  else if (ent === 'host') Array.from(doc.getElementsByTagName('HOST')).forEach((n) => add(readHost(n)));
  else Array.from(doc.getElementsByTagName('DOMAIN')).forEach((n) => add(readDomain(n)));

  const datetime = (doc.getElementsByTagName('DATETIME')[0]?.textContent ?? '').trim();
  return { entity: ent, datetime, records };
}

// XML の DATETIME（あれば）を yyyy-MM-dd へ。無ければ本日。
export function resolveSnapshotDate(datetime: string, today: string): string {
  if (datetime) {
    const d = new Date(datetime);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return today;
}
