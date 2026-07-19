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

// FQDN はラベルを "." で連ねた形。www. で始まっても構わない
// （"www. を付けない" は MAP の domain= パラメータ固有の指定であって、
//  検査対象ホスト名である AssetGroup の DNS Names には当てはまらない）。
const FQDN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
export const isFqdn = (raw: string): boolean => FQDN.test(raw.trim());

// 入力欄に薄く出す書式ガイド（そのまま placeholder に使う）。
export const IP_INPUT_HINT = '203.0.113.1 / 203.0.113.0/24 / 203.0.113.1-203.0.113.99\nカンマ区切り・改行区切りで複数可（プライベートIP不可）';
export const FQDN_INPUT_HINT = 'host1.example.jp\nカンマ区切り・改行区切りで複数可';

export interface TokenParse { tokens: string[]; errors: string[] }

// 入力の分割: カンマ・改行（CR/LF）・タブのいずれでも区切れる。
// 貼り付け（Excel の1列コピー等）をそのまま受けられるようにするため。
const splitTokens = (raw: string): string[] => (raw || '').split(/[,\r\n\t]+/);

// カンマ区切りを分割して正規化する。レンジは展開しない（表記のまま 1 件として扱う）。
// 形式に合わないものは errors に入れ、呼び出し側で警告を出して修正を促す。
export function parseIpInput(raw: string): TokenParse {
  const tokens: string[] = []; const errors: string[] = [];
  for (const part of splitTokens(raw)) {
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
  for (const part of splitTokens(raw)) {
    const t = part.trim();
    if (!t) continue;
    if (isFqdn(t)) tokens.push(t); else errors.push(t);
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

// 検査対象の資産 1 件。資産ごとに SCAN / MAP のどちらを実施するかを持つ（両方可）。
//   SCAN 対象 → AssetGroup の ips / dns_names に登録し、AssetGroup 指定でスケジュール
//   MAP  対象 → domains に登録し、ドメイン指定でスケジュール
export interface AssetEntry { value: string; scan: boolean; map: boolean }

export interface ProvisionInput {
  applicationNo: string;   // 外部接続申請番号
  regionCode: string;      // 地域コード（静的の MAP 用ドメイン名に使う）
  assetType: AssetType;    // 静的(IP指定) / 動的(FQDN指定)
  assets: AssetEntry[];    // 検査対象（静的=IPトークン / 動的=FQDN）
  // 申請情報（任意）。Qualys へは AssetGroup の division / comments として記録する。
  subject?: string;        // 件名
  department?: string;     // 申請部門
  applicant?: string;      // 申請部門担当者
  note?: string;           // 備考（複数行）
}

const valueOf = (a: AssetEntry): string => a.value.trim();
export const scanAssets = (i: ProvisionInput): string[] => i.assets.filter((a) => a.scan).map(valueOf).filter(Boolean);
export const mapAssets = (i: ProvisionInput): string[] => i.assets.filter((a) => a.map).map(valueOf).filter(Boolean);

// 入力から Qualys へ渡す値をまとめて導出する（画面のプレビューにもそのまま使う）。
export interface ProvisionPlan {
  title: string;          // AssetGroup 名
  scanTargets: string[];  // AssetGroup の ips / dns_names に入れる資産
  mapTargets: string[];   // MAP 検査対象の資産
  domains: string[];      // domains へ登録する名前（MAP スケジュールの対象）
  netblocks: string[];    // 静的のとき、生成ドメインに紐付けるネットブロック
  withScan: boolean;
  withMap: boolean;
}

export function planProvision(i: ProvisionInput): ProvisionPlan {
  const isDyn = i.assetType === 'dynamic';
  const scanTargets = scanAssets(i);
  const mapTargets = mapAssets(i);
  return {
    title: assetGroupTitle(i.applicationNo),
    scanTargets,
    mapTargets,
    // 動的(FQDN)は FQDN 自体をドメインとして登録。静的(IP)は申請番号ベースの
    // ドメイン名を1つ払い出し、対象IPをそのネットブロックとして紐付ける。
    domains: mapTargets.length
      ? (isDyn ? mapTargets : [domainName(i.applicationNo, i.regionCode)].filter(Boolean))
      : [],
    netblocks: isDyn ? [] : mapTargets,
    withScan: scanTargets.length > 0,
    withMap: mapTargets.length > 0,
  };
}

export function validateProvision(i: ProvisionInput): string[] {
  const e: string[] = [];
  const no = i.applicationNo.trim();
  if (!no) e.push('外部接続申請番号を入力してください');
  // Qualys の制約: AssetGroup 名は一意で、"All" は使用不可。
  if (no && assetGroupTitle(no).toLowerCase() === 'all') e.push('AssetGroup 名に "All" は使用できません');
  const p = planProvision(i);
  const isStatic = i.assetType === 'static';

  if (!i.assets.length) {
    e.push(isStatic ? '検査資産情報の IP を1つ以上入力してください' : '検査資産情報の FQDN を1つ以上入力してください');
  } else if (!p.withScan && !p.withMap) {
    e.push('資産ごとに SCAN / MAP のどちらを実施するかを選んでください');
  }

  // 資産の書式（追加時に検証済みだが、念のため）。
  for (const a of i.assets) {
    const v = a.value.trim();
    if (!v) continue;
    if (isStatic) {
      if (!classifyIpToken(v)) e.push(`IP の表記が不正です: ${v}`);
      else if (containsPrivateIp(v)) e.push(`プライベートIPは登録できません: ${v}`);
    } else if (!isFqdn(v)) e.push(`FQDN の表記が不正です: ${v}`);
  }

  // MAP 用ドメインは静的のときだけ申請番号から払い出す。
  if (p.withMap && isStatic) {
    if (no && !toDnsLabel(no)) {
      e.push('申請番号に英数字が含まれていないため、MAP 用のドメイン名を作れません（英数字とハイフンを含めてください）');
    }
    if (!i.regionCode.trim()) e.push('MAP を実施する資産があるため、地域区分を選んでください');
    for (const d of p.domains) if (d.length > 253) e.push(`ドメイン名が長すぎます（253文字以内）: ${d}`);
  }
  return e;
}

// AssetGroup 作成（/api/2.0/fo/asset/group/?action=add）のパラメータ。
// SCAN 対象だけを ips / dns_names に載せる（MAP 対象は domains 側で扱う）。
// 空の項目は送らない（Qualys が不正パラメータとして弾くのを避ける）。
export function buildAssetGroupParams(i: ProvisionInput): Record<string, string> {
  const p = planProvision(i);
  const params: Record<string, string> = { action: 'add', title: p.title };
  if (p.scanTargets.length) {
    if (i.assetType === 'static') params.ips = p.scanTargets.join(',');
    else params.dns_names = p.scanTargets.join(',');
  }
  // 申請情報を Qualys 側にも残す（division=申請部門 / comments=件名・担当者・備考の連結）。
  const dep = (i.department ?? '').trim();
  if (dep) params.division = dep;
  const comments = [
    (i.subject ?? '').trim() && `件名: ${(i.subject ?? '').trim()}`,
    (i.applicant ?? '').trim() && `申請部門担当者: ${(i.applicant ?? '').trim()}`,
    (i.note ?? '').trim() && `備考: ${(i.note ?? '').trim()}`,
  ].filter(Boolean).join(' / ');
  if (comments) params.comments = comments;
  return params;
}

// ドメイン登録（/msp/asset_domain.php?action=add）のパラメータ。
// 静的は生成ドメイン＋対象IPのネットブロック、動的は FQDN をそのまま登録する。
export function buildDomainParams(i: ProvisionInput, domain: string): Record<string, string> {
  const p = planProvision(i);
  const params: Record<string, string> = { action: 'add', domain };
  if (p.netblocks.length) params.netblock = p.netblocks.join(',');
  return params;
}

// スケジュールのタイトル: AssetGroup 名の後ろに種別（_s_ / _m_）と検査予定日を挟む。
//   例) EXT-2026-001(仮)_s_20260801 / EXT-2026-001(仮)_m_20260801
export const scheduleTitle = (agTitle: string, kind: 'scan' | 'map', ymd: string): string =>
  `${agTitle}${kind === 'map' ? '_m_' : '_s_'}${ymd}`;

// 確認モーダルに出す要約（何が作られるかを列挙する）。
export function describeProvision(i: ProvisionInput): string[] {
  const p = planProvision(i);
  const kindLabel = i.assetType === 'dynamic' ? '動的・FQDN指定' : '静的・IP指定';
  const lines = [`AssetGroup「${p.title}」を作成（${kindLabel}）`];
  if ((i.subject ?? '').trim()) lines.push(`　件名: ${(i.subject ?? '').trim()}`);
  if (p.withScan) lines.push(`　SCAN 対象（${i.assetType === 'static' ? 'IP_SET' : 'DNS_LIST'}）: ${p.scanTargets.join(', ')}`);
  else lines.push('　SCAN 対象なし（AssetGroup のみ作成）');
  for (const d of p.domains) {
    const nb = p.netblocks.length ? `（ネットブロック: ${p.netblocks.join(', ')}）` : '';
    lines.push(`ドメイン「${d}」を登録${nb}`);
  }
  if (p.withScan) lines.push(`SCAN スケジュールを登録（対象: ${p.title}）`);
  if (p.withMap) lines.push(`MAP スケジュールを登録（対象: ${p.domains.join(', ')}）`);
  return lines;
}
