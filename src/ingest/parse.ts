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
    case 'USER_LIST_OUTPUT': return 'user';
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
  // 業務情報（画面の Division/Function/Location/Comments）。返す API なら取得・差分対象に。
  r.scalar.DIVISION = text(ag, 'DIVISION');
  r.scalar.FUNCTION = text(ag, 'FUNCTION');
  r.scalar.LOCATION = text(ag, 'LOCATION');
  r.scalar.COMMENTS = text(ag, 'COMMENTS');
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

function readUser(u: Element): QamRecord {
  const r = newRecord();
  const login = text(u, 'USER_LOGIN');
  // v2(/fo/user/) は USER_ID を持つが、MSP(user_list.php) は持たない → ログインをキーに。
  r.key = text(u, 'USER_ID') || login;
  const ci = u.getElementsByTagName('CONTACT_INFO')[0] ?? null;
  const fn = ci ? text(ci, 'FIRSTNAME') : '';
  const ln = ci ? text(ci, 'LASTNAME') : '';
  r.scalar.USER_LOGIN = login;
  r.scalar.NAME = [ln, fn].filter(Boolean).join(' ');
  r.scalar.EMAIL = ci ? text(ci, 'EMAIL') : '';
  r.scalar.TITLE = ci ? text(ci, 'TITLE') : '';
  r.scalar.COMPANY = ci ? text(ci, 'COMPANY') : '';
  r.scalar.USER_STATUS = text(u, 'USER_STATUS');
  r.scalar.USER_ROLE = text(u, 'USER_ROLE');
  r.scalar.BUSINESS_UNIT = text(u, 'BUSINESS_UNIT');
  // 割当 AssetGroup（このユーザがアクセスできる AssetGroup。Manager/Auditor は無し＝全体）。
  r.set.ASSIGNED_GROUPS = uniq(listValues(u, 'ASSIGNED_ASSET_GROUPS', 'ASSET_GROUP_TITLE'));
  r.info.LAST_LOGIN_DATE = text(u, 'LAST_LOGIN_DATE');
  r.name = login || r.scalar.NAME;
  return r;
}

// QPS REST(ServiceResponse) の <User>。FO/MSP の USER_LIST_OUTPUT とは要素名が異なる（camelCase）。
function readUserQps(u: Element): QamRecord {
  const r = newRecord();
  const pick = (...tags: string[]): string => { for (const t of tags) { const v = text(u, t); if (v) return v; } return ''; };
  const login = pick('username', 'login', 'userLogin');
  r.key = pick('id', 'userId') || login;
  r.scalar.USER_LOGIN = login;
  const fn = pick('firstName', 'firstname'); const ln = pick('lastName', 'lastname');
  r.scalar.NAME = [ln, fn].filter(Boolean).join(' ');
  r.scalar.EMAIL = pick('emailAddress', 'email');
  r.scalar.TITLE = pick('title');
  r.scalar.COMPANY = pick('company');
  const active = pick('active');
  r.scalar.USER_STATUS = active ? (active.toLowerCase() === 'true' ? 'Active' : 'Inactive') : pick('userStatus', 'status');
  // ロール: roleName/role か、roleList 配下の name を連結。
  const roleList = u.getElementsByTagName('roleList')[0] ?? null;
  r.scalar.USER_ROLE = pick('roleName', 'role') || uniq(tagValues(roleList, 'name')).join(', ');
  r.info.LAST_LOGIN_DATE = pick('lastLoginDate', 'lastLogin', 'lastLoginDatetime');
  r.name = login || r.scalar.NAME;
  return r;
}

export function parseQualysXml(xml: string, entity?: QamEntity): QamSnapshot {
  // 先頭の BOM と空白/改行を除去（XML 宣言 <?xml は必ず先頭。先頭に空白/改行があると
  // それだけで parsererror になる＝Qualys/Windows 由来ファイルでよくある）。
  const cleaned = xml.replace(/^﻿/, '').replace(/^\s+/, '');
  const doc = new DOMParser().parseFromString(cleaned, 'application/xml');
  const root = doc.documentElement;
  if (!root) throw new Error('XML を解析できませんでした（空ファイル？）');
  const rootName = root.nodeName;
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (rootName.toLowerCase() === 'parsererror' || pe) {
    const detail = ((pe ? pe.textContent : rootName) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error('XML を解析できませんでした: ' + detail);
  }
  // Qualys はエラーを HTTP 200 + <SIMPLE_RETURN> で返すことがある（認証/権限エラー等）。
  // 0 件として黙って取り込むと「反映されない」になるので、本文を出して中断する。
  if (rootName === 'SIMPLE_RETURN') {
    const t = doc.getElementsByTagName('TEXT')[0];
    throw new Error('Qualys エラー応答: ' + (t && t.textContent ? t.textContent.trim() : 'エラーが返されました'));
  }
  // QPS REST 応答（user は /qps/rest/2.0/search/am/user）。ルートは ServiceResponse。
  if (rootName === 'ServiceResponse') {
    const rc = text(root, 'responseCode');
    if (rc && rc !== 'SUCCESS') {
      const em = text(root, 'errorMessage');
      throw new Error('Qualys QPS エラー: ' + rc + (em ? ' ' + em : ''));
    }
    if (entity && entity !== 'user') throw new Error(`種別が一致しません（QPS 応答は user のみ対応 / 要求: ${entity}）`);
    const recs: QamRecords = {};
    Array.from(doc.getElementsByTagName('User')).forEach((n) => {
      const r = readUserQps(n);
      if (!r.key) return;
      r.hash = hashRecord(r);
      recs[r.key] = r;
    });
    return { entity: 'user', datetime: '', records: recs };
  }
  const detected = entityFromRoot(rootName);
  if (!detected) throw new Error(`未対応の XML ルート要素です: ${rootName}`);
  if (entity && entity !== detected) throw new Error(`種別が一致しません（要求: ${entity} / 実際: ${detected}）`);
  const ent = detected;

  const records: QamRecords = {};
  const add = (r: QamRecord) => {
    if (!r.key) return;
    r.hash = hashRecord(r);
    records[r.key] = r;
  };
  if (ent === 'group') Array.from(doc.getElementsByTagName('ASSET_GROUP')).forEach((n) => add(readGroup(n)));
  else if (ent === 'host') Array.from(doc.getElementsByTagName('HOST')).forEach((n) => add(readHost(n)));
  else if (ent === 'user') Array.from(doc.getElementsByTagName('USER')).forEach((n) => add(readUser(n)));
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
