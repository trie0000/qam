// 検査登録の前段（AssetGroup / ドメインの払い出し）ロジック。純粋関数のみ。
//
// 運用ルール:
//   - SCAN は AssetGroup 単位、MAP はドメイン単位で検査する。
//   - AssetGroup 名 = 「外部接続申請番号(仮)」。Qualys 側で **一意必須**・"All" は使用不可。
//   - ドメイン名 = 小文字にした申請番号 + "." + 地域コード（(仮) は DNS 名に使えないので省く）。
//   - AssetGroup の IP_SET / DNS_LIST に検査対象の IP / DNS を設定する。
//     IP は「単体（CIDR 含む）」と「レンジ（開始-終了）」を行ごとに切り替えて複数指定できる。

export type InspectKind = 'scan' | 'map' | 'both';
// 資産種別。静的=IP 資産（IP_SET に登録・SCAN/MAP を選べる）
//           動的=FQDN 指定（DNS_LIST に登録・SCAN のみ。IP/レンジは登録しない）
export type AssetType = 'static' | 'dynamic';
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

// 検査資産情報は 1 つのテキスト欄で受け、カンマ区切りで複数指定できる。
// IP は「単体 / CIDR / レンジ」の 3 形式。レンジは展開せず表記のまま Qualys へ渡す。
export type IpTokenKind = 'single' | 'cidr' | 'range';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIpv4 = (s: string): boolean => {
  const m = s.match(IPV4);
  return !!m && m.slice(1).every((p) => Number(p) <= 255 && String(Number(p)) === p.replace(/^0+(?=\d)/, ''));
};
const isCidr = (s: string): boolean => {
  const i = s.indexOf('/');
  if (i < 0) return false;
  const bits = Number(s.slice(i + 1));
  return isIpv4(s.slice(0, i)) && Number.isInteger(bits) && bits >= 0 && bits <= 32;
};

// プライベートIP（RFC1918）判定。外部接続申請にもとづく検査対象は
// グローバルIPが前提なので、プライベートIPは登録させない。
const ipToInt = (s: string): number => s.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const PRIVATE_RANGES: [number, number][] = [
  [ipToInt('10.0.0.0'), ipToInt('10.255.255.255')],
  [ipToInt('172.16.0.0'), ipToInt('172.31.255.255')],
  [ipToInt('192.168.0.0'), ipToInt('192.168.255.255')],
];
const isPrivateIpv4 = (s: string): boolean => {
  const n = ipToInt(s);
  return PRIVATE_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
};

// トークンがプライベートIPを含むか（レンジは両端、CIDR はネットワークアドレスで判定）。
export function containsPrivateIp(raw: string): boolean {
  const t = normalizeIpToken(raw);
  const kind = classifyIpToken(t);
  if (kind === 'single') return isPrivateIpv4(t);
  if (kind === 'cidr') return isPrivateIpv4(t.slice(0, t.indexOf('/')));
  if (kind === 'range') {
    const i = t.indexOf('-');
    return isPrivateIpv4(t.slice(0, i)) || isPrivateIpv4(t.slice(i + 1));
  }
  return false;
}

// レンジの "-" は両端に半角スペースがあっても受ける。前後の余計な空白は落とす。
export const normalizeIpToken = (raw: string): string => raw.trim().replace(/\s*-\s*/g, '-');

export function classifyIpToken(raw: string): IpTokenKind | null {
  const t = normalizeIpToken(raw);
  if (isIpv4(t)) return 'single';
  if (isCidr(t)) return 'cidr';
  const i = t.indexOf('-');
  if (i > 0 && isIpv4(t.slice(0, i)) && isIpv4(t.slice(i + 1))) return 'range';
  return null;
}

// FQDN はラベルを "." で連ねた形（先頭 www. は Qualys の指定により不可）。
const FQDN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
export const isFqdn = (raw: string): boolean => FQDN.test(raw.trim());

// 入力欄に薄く出す書式ガイド（そのまま placeholder に使う）。
export const IP_INPUT_HINT = '203.0.113.1 / 203.0.113.0/24 / 203.0.113.1-203.0.113.99（カンマ区切りで複数可・プライベートIP不可）';
export const FQDN_INPUT_HINT = 'host1.example.jp（www. は付けない・カンマ区切りで複数可）';

export interface TokenParse { tokens: string[]; errors: string[] }

// カンマ区切りを分割して正規化する。レンジは展開しない（表記のまま 1 件として扱う）。
// 形式に合わないものは errors に入れ、呼び出し側で警告を出して修正を促す。
export function parseIpInput(raw: string): TokenParse {
  const tokens: string[] = []; const errors: string[] = [];
  for (const part of (raw || '').split(',')) {
    const t = normalizeIpToken(part);
    if (!t) continue;
    if (!classifyIpToken(t)) { errors.push(t); continue; }
    // プライベートIPは検査対象にしない（グローバルIP前提の外部接続申請のため）。
    if (containsPrivateIp(t)) { errors.push(`${t}（プライベートIP）`); continue; }
    tokens.push(t);
  }
  return { tokens, errors };
}

export function parseFqdnInput(raw: string): TokenParse {
  const tokens: string[] = []; const errors: string[] = [];
  for (const part of (raw || '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (isFqdn(t) && !/^www\./i.test(t)) tokens.push(t); else errors.push(t);
  }
  return { tokens, errors };
}

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
  regionCode: string;      // 地域コード（MAP を含むときのみ使用）
  assetType: AssetType;    // 静的 / 動的(FQDN指定)
  kind: InspectKind;       // 静的のとき: scan のみ / map のみ / 両方。動的は scan 固定
  ips: string[];           // 静的の検査資産情報（正規化済みトークン。動的では使わない）
  dnsNames: string[];      // 動的の検査資産情報=FQDN（静的では使わない）
  // 申請情報（任意）。Qualys へは AssetGroup の division / comments として記録する。
  subject?: string;        // 件名
  department?: string;     // 申請部門
  applicant?: string;      // 申請者（既定は記入者名）
  note?: string;           // 備考（複数行）
}

// 動的は MAP を実施できない（IP ネットブロックを持たない）ため、種別は常に scan として扱う。
export const effectiveKind = (i: Pick<ProvisionInput, 'assetType' | 'kind'>): InspectKind =>
  (i.assetType === 'dynamic' ? 'scan' : i.kind);

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
  const kind = effectiveKind(i);
  const isDyn = i.assetType === 'dynamic';
  return {
    title: assetGroupTitle(i.applicationNo),
    // 動的は MAP をしないのでドメインを払い出さない。
    domain: isDyn ? '' : domainName(i.applicationNo, i.regionCode),
    // 静的=IP のみ / 動的=FQDN のみ（もう一方の入力は捨てて、意図しない登録を防ぐ）。
    ips: isDyn ? [] : i.ips.map(normalizeIpToken).filter(Boolean),
    dnsNames: isDyn ? i.dnsNames.map((d) => d.trim()).filter(Boolean) : [],
    withScan: needsScan(kind),
    withMap: !isDyn && needsMap(kind),
  };
}

export function validateProvision(i: ProvisionInput): string[] {
  const e: string[] = [];
  const no = i.applicationNo.trim();
  if (!no) e.push('外部接続申請番号を入力してください');
  // Qualys の制約: AssetGroup 名は一意で、"All" は使用不可。
  if (no && assetGroupTitle(no).toLowerCase() === 'all') e.push('AssetGroup 名に "All" は使用できません');
  const p = planProvision(i);
  if (p.withMap) {
    if (no && !toDnsLabel(no)) {
      e.push('申請番号に英数字が含まれていないため、ドメイン名を作れません（英数字とハイフンを含めてください）');
    }
    if (!i.regionCode.trim()) e.push('地域区分を選んでください');
    if (p.domain && p.domain.length > 253) e.push('ドメイン名が長すぎます（253文字以内）');
  }
  if (i.assetType === 'static') {
    // 追加時に検証済みだが、念のためここでも形式を確認する。
    for (const t of p.ips) {
      if (!classifyIpToken(t)) e.push(`IP の表記が不正です: ${t}`);
      else if (containsPrivateIp(t)) e.push(`プライベートIPは登録できません: ${t}`);
    }
    if (!p.ips.length) e.push('検査資産情報の IP を1つ以上入力してください');
  } else {
    if (!p.dnsNames.length) e.push('検査資産情報の FQDN を1つ以上入力してください');
    for (const d of p.dnsNames) {
      if (/^www\./i.test(d)) e.push(`FQDN の先頭に "www." は付けないでください: ${d}`);
      else if (!isFqdn(d)) e.push(`FQDN の表記が不正です: ${d}`);
    }
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
  // 申請情報を Qualys 側にも残す（division=申請部門 / comments=件名・申請者・備考の連結）。
  const dep = (i.department ?? '').trim();
  if (dep) params.division = dep;
  const comments = [
    (i.subject ?? '').trim() && `件名: ${(i.subject ?? '').trim()}`,
    (i.applicant ?? '').trim() && `申請者: ${(i.applicant ?? '').trim()}`,
    (i.note ?? '').trim() && `備考: ${(i.note ?? '').trim()}`,
  ].filter(Boolean).join(' / ');
  if (comments) params.comments = comments;
  return params;
}

// 確認モーダルに出す要約（何が作られるかを列挙する）。
export function describeProvision(i: ProvisionInput): string[] {
  const p = planProvision(i);
  const lines = [`AssetGroup「${p.title}」を作成（${i.assetType === 'dynamic' ? '動的・FQDN指定' : '静的・IP資産'}）`];
  if ((i.subject ?? '').trim()) lines.push(`　件名: ${(i.subject ?? '').trim()}`);
  if (p.ips.length) lines.push(`　IP: ${p.ips.join(', ')}`);
  if (p.dnsNames.length) lines.push(`　FQDN: ${p.dnsNames.join(', ')}`);
  if (p.withMap) lines.push(`ドメイン「${p.domain}」を登録`);
  if (p.withScan) lines.push(`SCAN スケジュールを登録（対象: ${p.title}）`);
  if (p.withMap) lines.push(`MAP スケジュールを登録（対象: ${p.domain}）`);
  return lines;
}
