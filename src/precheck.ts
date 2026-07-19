// 検査登録の事前チェック。取り込み済みスナップショット（AssetGroup / ドメイン / host list）と
// 入力内容を突き合わせ、登録前に次を知らせる:
//   1) 同名の AssetGroup・ドメインが既にあるか（＝新規作成ではなく更新になる）
//   2) 検査対象の IP / FQDN が host list に既にあるか（＝どれが新規登録されるか）
//   3) 登録方法と既存のトラッキング方式が食い違っていないか
//      （FQDN で登録するのに既存は IP トラッキング／静的IPで登録するのに既存は DNS トラッキング）
// 判定材料は API ではなく取込済みスナップショットなので「いつ時点か」も併せて返す。
// Qualys への実登録時は別途ライブで存在確認する（ここは入力中の予告表示のため）。
import { ipBounds, type AssetType } from './provision';
import type { QamRecords } from './types';

// host list の 1 ホスト（判定に使う項目だけ）。
export interface HostFact { id: string; ip: string; ipInt: number | null; name: string; tracking: string }

export interface RegistrySource { stamp: string; records: QamRecords }

export interface AssetRegistry {
  stamps: { group: string; domain: string; host: string }; // '' = 未取込（判定不可）
  groups: Map<string, string>;   // 小文字タイトル → 元のタイトル
  domains: Map<string, string>;  // 小文字ドメイン名 → 元の表記
  hosts: HostFact[];
  byName: Map<string, HostFact>; // FQDN / DNS（小文字）→ ホスト
}

export const emptyRegistry = (): AssetRegistry => ({
  stamps: { group: '', domain: '', host: '' },
  groups: new Map(), domains: new Map(), hosts: [], byName: new Map(),
});

export function buildRegistry(src: { group?: RegistrySource; domain?: RegistrySource; host?: RegistrySource }): AssetRegistry {
  const reg = emptyRegistry();
  if (src.group) {
    reg.stamps.group = src.group.stamp;
    for (const r of Object.values(src.group.records)) {
      const t = (r.scalar.TITLE || r.name || '').trim();
      if (t) reg.groups.set(t.toLowerCase(), t);
    }
  }
  if (src.domain) {
    reg.stamps.domain = src.domain.stamp;
    for (const r of Object.values(src.domain.records)) {
      const d = (r.scalar.DOMAIN_NAME || r.name || '').trim();
      if (d) reg.domains.set(d.toLowerCase(), d);
    }
  }
  if (src.host) {
    reg.stamps.host = src.host.stamp;
    for (const r of Object.values(src.host.records)) {
      const ip = (r.scalar.IP || '').trim();
      const h: HostFact = {
        id: r.key,
        ip,
        ipInt: ipBounds(ip)?.[0] ?? null,
        name: (r.scalar.FQDN || r.scalar.DNS || '').trim(),
        tracking: (r.scalar.TRACKING_METHOD || '').trim().toUpperCase(),
      };
      reg.hosts.push(h);
      // 同名が複数あっても先勝ち（トラッキング方式の食い違いを見るだけなので 1 件で足りる）。
      for (const n of [r.scalar.FQDN, r.scalar.DNS]) {
        const k = (n || '').trim().toLowerCase();
        if (k && !reg.byName.has(k)) reg.byName.set(k, h);
      }
    }
  }
  return reg;
}

// 登録方法と既存トラッキング方式の食い違い。
//   ip-tracked-fqdn: FQDN で登録するのに、既存ホストは IP トラッキング
//   dns-tracked-ip : 静的IPで登録するのに、既存ホストは DNS トラッキング
export type TrackingIssue = 'ip-tracked-fqdn' | 'dns-tracked-ip';

export interface AssetCheck {
  value: string;
  state: 'new' | 'known' | 'unknown'; // unknown = host 未取込・書式不正で判定できない
  hits: HostFact[];                   // 該当した既存ホスト（レンジ指定なら複数）
  issue?: TrackingIssue;
}

// 資産 1 件を host list と突き合わせる。静的は IP 範囲（単体/CIDR/レンジ）で、
// 動的は FQDN 名で照合する。
export function checkAsset(reg: AssetRegistry, assetType: AssetType, value: string): AssetCheck {
  const v = value.trim();
  const unknown: AssetCheck = { value: v, state: 'unknown', hits: [] };
  if (!v || !reg.stamps.host) return unknown;
  if (assetType === 'dynamic') {
    const h = reg.byName.get(v.toLowerCase());
    if (!h) return { value: v, state: 'new', hits: [] };
    return { value: v, state: 'known', hits: [h], issue: h.tracking === 'IP' ? 'ip-tracked-fqdn' : undefined };
  }
  const b = ipBounds(v);
  if (!b) return unknown;
  const hits = reg.hosts.filter((h) => h.ipInt !== null && h.ipInt >= b[0] && h.ipInt <= b[1]);
  if (!hits.length) return { value: v, state: 'new', hits: [] };
  return { value: v, state: 'known', hits, issue: hits.some((h) => h.tracking === 'DNS') ? 'dns-tracked-ip' : undefined };
}

const TRACKING_LABEL: Record<string, string> = { IP: 'IP追跡', DNS: 'DNS追跡', NETBIOS: 'NetBIOS追跡', EC2: 'EC2追跡', AGENT: 'エージェント' };
const trackingLabel = (hits: HostFact[]): string => {
  const set = Array.from(new Set(hits.map((h) => TRACKING_LABEL[h.tracking] ?? (h.tracking || '方式不明'))));
  return set.join('/');
};

// 既存ホストの識別子（理由文に出す。多いときは先頭だけ）。
const hostsLabel = (c: AssetCheck): string => {
  const names = c.hits.map((h) => h.name || h.ip).filter(Boolean);
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` ほか ${names.length - 3} 件` : '');
};

// 資産リストの横に出すバッジ。新規＝検査時に host list へ追加登録される見込みのもの。
export interface AssetBadge { text: string; tone: 'new' | 'warn' | 'ok' | 'muted'; title: string }
export function assetBadge(c: AssetCheck): AssetBadge {
  if (c.state === 'unknown') {
    return { text: '判定不可', tone: 'muted', title: 'host 一覧が未取込のため、既存かどうか判定できません。' };
  }
  if (c.state === 'new') {
    return { text: '新規', tone: 'new', title: 'host list に未登録です。検査の実行時に新しいホストとして登録されます。' };
  }
  const count = c.hits.length > 1 ? ` ${c.hits.length}件` : '';
  const text = `既存${count}・${trackingLabel(c.hits)}`;
  if (c.issue) return { text, tone: 'warn', title: issueLines(c).join('\n') };
  return { text, tone: 'ok', title: `host list に登録済みです（${hostsLabel(c)}）。` };
}

// 食い違いの理由。検査担当に確認してもらうための説明なので、何が起きるかまで書く。
export function issueLines(c: AssetCheck): string[] {
  if (c.issue === 'ip-tracked-fqdn') {
    return [
      `${c.value}: FQDN として登録しようとしていますが、host list には IP トラッキングのホストとして登録済みです（${hostsLabel(c)}）。`,
      'IP トラッキングのホストは IP で同定されるため、FQDN の名前解決先が変わっても追従しません。'
      + 'この FQDN を AssetGroup の DNS Names に登録しても、検査結果は既存の IP 側の資産に紐づきます。',
    ];
  }
  if (c.issue === 'dns-tracked-ip') {
    return [
      `${c.value}: 静的（IP 指定）で登録しようとしていますが、host list には DNS トラッキングのホストとして登録済みです（${hostsLabel(c)}）。`,
      'DNS トラッキングのホストは名前で同定されるため、名前解決先が変われば別の IP へ移動します。'
      + '固定 IP の資産として登録すると、同じ実体が IP 側・DNS 側で二重管理になることがあります。',
    ];
  }
  return [];
}

export const TRACKING_CONFIRM_NOTE =
  'この内容で登録してよいか検査担当に確認してください。確認が取れた場合のみ、下のチェックを入れて登録できます。';

// 取込日（stamp = 'YYYY-MM-DDTHH-mm-ss'）の日付部分。
const dateOf = (stamp: string): string => stamp.slice(0, 10);

// 既に取り込み済みデータに存在する AssetGroup / ドメイン。プレビュー下の赤字表示に使う。
export function existingNameLines(reg: AssetRegistry, title: string, domains: string[]): string[] {
  const out: string[] = [];
  const g = reg.groups.get(title.trim().toLowerCase());
  if (g) {
    out.push(`AssetGroup「${g}」は取り込み済みデータ（${dateOf(reg.stamps.group)} 取込）に既にあります。`
      + '新規作成ではなく、既存の AssetGroup に今回の対象を追加する更新になります。');
  }
  for (const d of domains) {
    const hit = reg.domains.get(d.trim().toLowerCase());
    if (hit) {
      out.push(`ドメイン「${hit}」は取り込み済みデータ（${dateOf(reg.stamps.domain)} 取込）に既にあります。`
        + '新規登録ではなく、既存ドメインにネットブロックを追加する更新になります。');
    }
  }
  return out;
}

// host list へ新規登録される見込みの資産（＝未登録のもの）。
export const newHostAssets = (checks: AssetCheck[]): AssetCheck[] => checks.filter((c) => c.state === 'new');
