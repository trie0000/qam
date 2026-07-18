// 検査登録の前段（AssetGroup / ドメインの払い出し）ロジック。純粋関数のみ。
//
// 運用ルール:
//   - SCAN は AssetGroup 単位、MAP はドメイン単位で検査する。
//   - AssetGroup 名 = 「外部接続申請番号(仮)」。Qualys 側で **一意必須**・"All" は使用不可。
//   - ドメイン名 = 小文字にした申請番号 + "." + 地域コード（(仮) は DNS 名に使えないので省く）。
//   - AssetGroup の IP_SET / DNS_LIST に検査対象の IP / DNS を設定する。
//     IP は「単体（CIDR 含む）」と「レンジ（開始-終了）」を行ごとに切り替えて複数指定できる。

export type InspectKind = 'scan' | 'map' | 'both';
export type IpMode = 'single' | 'range';

export interface RegionOption { label: string; code: string }

// 既定の地域区分。設定（共通設定）で変更できる。
export const DEFAULT_REGIONS: RegionOption[] = [
  { label: '日本', code: 'jp' },
  { label: '北米', code: 'na' },
  { label: '中南米', code: 'la' },
  { label: '欧州・CIS・中東阿', code: 'eu' },
  { label: 'インド', code: 'in' },
  { label: '中国・北東アジア', code: 'cn' },
];

// 設定文字列 "日本=jp,北米=na,…" ⇄ 配列。不正な行は捨て、空なら既定へ戻す。
export function parseRegions(src: string): RegionOption[] {
  const out: RegionOption[] = [];
  for (const part of (src || '').split(',')) {
    const [label, code] = part.split('=');
    const l = (label ?? '').trim();
    const c = (code ?? '').trim().toLowerCase();
    if (l && /^[a-z0-9-]+$/.test(c)) out.push({ label: l, code: c });
  }
  return out.length ? out : DEFAULT_REGIONS;
}
export const formatRegions = (list: RegionOption[]): string =>
  list.map((r) => `${r.label}=${r.code}`).join(',');

export interface IpEntry { mode: IpMode; single: string; from: string; to: string }
export const emptyIpEntry = (): IpEntry => ({ mode: 'single', single: '', from: '', to: '' });

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIpv4 = (s: string): boolean => {
  const m = s.trim().match(IPV4);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
};
// 単体欄は CIDR も許す（Qualys の ips は 10.1.1.1/31 のような表記も受け付ける）。
const isIpOrCidr = (s: string): boolean => {
  const [ip, bits] = s.trim().split('/');
  if (!isIpv4(ip)) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= 32;
};

// 1 行を Qualys の ips パラメータ用トークンにする。未入力は空文字。
export function ipEntryValue(e: IpEntry): string {
  if (e.mode === 'range') {
    const from = e.from.trim(); const to = e.to.trim();
    return from && to ? `${from}-${to}` : '';
  }
  return e.single.trim();
}

// 行ごとの入力エラー（空行は呼び出し側で除外するので、ここでは値がある行だけ見る）。
export function ipEntryError(e: IpEntry): string {
  if (e.mode === 'range') {
    const from = e.from.trim(); const to = e.to.trim();
    if (!from && !to) return '';
    if (!isIpv4(from) || !isIpv4(to)) return `IP レンジの表記が不正です: ${from || '(空)'}-${to || '(空)'}`;
    return '';
  }
  const v = e.single.trim();
  if (!v) return '';
  return isIpOrCidr(v) ? '' : `IP の表記が不正です: ${v}`;
}

const hasValue = (e: IpEntry): boolean => !!ipEntryValue(e);

// AssetGroup 名。Qualys 側で一意必須なので、申請番号をそのまま識別子に使う。
export const assetGroupTitle = (applicationNo: string): string => `${applicationNo.trim()}(仮)`;

// DNS ラベルとして使える形に落とす（英数字とハイフンのみ・小文字・前後のハイフンを除去）。
// 「(仮)」や全角文字は DNS 名に使えないため、ここで落ちる。
export function toDnsLabel(src: string): string {
  return (src || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63); // DNS の 1 ラベル上限
}

// ドメイン名 = 小文字の申請番号 + "." + 地域コード。(仮) は含めない。
export function domainName(applicationNo: string, regionCode: string): string {
  const label = toDnsLabel(applicationNo);
  const code = toDnsLabel(regionCode);
  return label && code ? `${label}.${code}` : '';
}

export interface ProvisionInput {
  applicationNo: string;   // 外部接続申請番号
  regionCode: string;      // 地域コード
  kind: InspectKind;       // scan のみ / map のみ / 両方
  ips: IpEntry[];
  dnsNames: string[];
}

export const needsScan = (k: InspectKind): boolean => k === 'scan' || k === 'both';
export const needsMap = (k: InspectKind): boolean => k === 'map' || k === 'both';

// 入力から Qualys へ渡す値をまとめて導出する（画面のプレビューにもそのまま使う）。
export interface ProvisionPlan {
  title: string;        // AssetGroup 名
  domain: string;       // MAP 対象ドメイン（map を含まないときも参考表示する）
  ips: string[];        // ips パラメータ用トークン
  dnsNames: string[];
  withScan: boolean;
  withMap: boolean;
}
export function planProvision(i: ProvisionInput): ProvisionPlan {
  return {
    title: assetGroupTitle(i.applicationNo),
    domain: domainName(i.applicationNo, i.regionCode),
    ips: i.ips.filter(hasValue).map(ipEntryValue),
    dnsNames: i.dnsNames.map((d) => d.trim()).filter(Boolean),
    withScan: needsScan(i.kind),
    withMap: needsMap(i.kind),
  };
}

export function validateProvision(i: ProvisionInput): string[] {
  const e: string[] = [];
  const no = i.applicationNo.trim();
  if (!no) e.push('外部接続申請番号を入力してください');
  // Qualys の制約: AssetGroup 名は一意で、"All" は使用不可。
  if (no && assetGroupTitle(no).toLowerCase() === 'all') e.push('AssetGroup 名に "All" は使用できません');
  const p = planProvision(i);
  if (no && !toDnsLabel(no)) {
    e.push('申請番号に英数字が含まれていないため、ドメイン名を作れません（英数字とハイフンを含めてください）');
  }
  if (needsMap(i.kind)) {
    if (!i.regionCode.trim()) e.push('地域区分を選んでください');
    if (p.domain && p.domain.length > 253) e.push('ドメイン名が長すぎます（253文字以内）');
  }
  for (const row of i.ips) {
    const err = ipEntryError(row);
    if (err) e.push(err);
  }
  for (const d of p.dnsNames) {
    // ドメイン名のみ（www. は付けない）という Qualys の指定に沿ってチェックする。
    if (/^www\./i.test(d)) e.push(`DNS 名の先頭に "www." は付けないでください: ${d}`);
  }
  if (needsScan(i.kind) && !p.ips.length && !p.dnsNames.length) {
    e.push('SCAN 対象の IP または DNS を1つ以上入力してください');
  }
  return e;
}

// AssetGroup 作成（/api/2.0/fo/asset/group/?action=add）のパラメータ。
// 空の項目は送らない（Qualys が不正パラメータとして弾くのを避ける）。
export function buildAssetGroupParams(i: ProvisionInput): Record<string, string> {
  const p = planProvision(i);
  const params: Record<string, string> = { action: 'add', title: p.title };
  if (p.ips.length) params.ips = p.ips.join(',');
  if (p.dnsNames.length) params.dns_names = p.dnsNames.join(',');
  if (p.withMap && p.domain) params.domains = p.domain;
  return params;
}

// 確認モーダルに出す要約（何が作られるかを列挙する）。
export function describeProvision(i: ProvisionInput): string[] {
  const p = planProvision(i);
  const lines = [`AssetGroup「${p.title}」を作成`];
  if (p.ips.length) lines.push(`　IP: ${p.ips.join(', ')}`);
  if (p.dnsNames.length) lines.push(`　DNS: ${p.dnsNames.join(', ')}`);
  if (p.withMap) lines.push(`ドメイン「${p.domain}」を登録`);
  if (p.withScan) lines.push(`SCAN スケジュールを登録（対象: ${p.title}）`);
  if (p.withMap) lines.push(`MAP スケジュールを登録（対象: ${p.domain}）`);
  return lines;
}
