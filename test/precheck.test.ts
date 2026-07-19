import { describe, it, expect } from 'vitest';
import {
  buildRegistry, emptyRegistry, checkAsset, assetBadge, issueLines,
  existingNameLines, newHostAssets, type RegistrySource,
} from '../src/precheck';
import type { QamRecord, QamRecords } from '../src/types';

const rec = (key: string, scalar: Record<string, string>): QamRecord =>
  ({ key, name: scalar.TITLE ?? scalar.DOMAIN_NAME ?? scalar.FQDN ?? scalar.IP ?? key, scalar, set: {}, info: {}, hash: '' });

const records = (...rs: QamRecord[]): QamRecords => Object.fromEntries(rs.map((r) => [r.key, r]));
const src = (records: QamRecords, stamp = '2026-07-18T09-00-00'): RegistrySource => ({ stamp, records });

const host = (id: string, ip: string, fqdn: string, tracking: string) =>
  rec(id, { IP: ip, FQDN: fqdn, DNS: '', TRACKING_METHOD: tracking });

// 静的IP=203.0.113.1(IP追跡) / 203.0.113.9(DNS追跡)、動的=host1(IP追跡) が host list にある状態。
const reg = () => buildRegistry({
  group: src(records(rec('1', { TITLE: 'EXT-2026-001(仮)' }))),
  domain: src(records(rec('ext-2026-001.jp', { DOMAIN_NAME: 'ext-2026-001.jp' }))),
  host: src(records(
    host('h1', '203.0.113.1', 'a.example.jp', 'IP'),
    host('h2', '203.0.113.9', 'b.example.jp', 'DNS'),
    host('h3', '198.51.100.7', 'host1.example.jp', 'IP'),
  )),
});

describe('取り込み済みデータの突き合わせ', () => {
  it('host 未取込なら判定不可（新規と誤って断定しない）', () => {
    const c = checkAsset(emptyRegistry(), 'static', '203.0.113.1');
    expect(c.state).toBe('unknown');
    expect(assetBadge(c).text).toBe('判定不可');
  });

  it('host list に無い IP は新規（＝検査時に追加登録される）', () => {
    const c = checkAsset(reg(), 'static', '203.0.113.200');
    expect(c.state).toBe('new');
    expect(assetBadge(c)).toMatchObject({ text: '新規', tone: 'new' });
    expect(newHostAssets([c])).toHaveLength(1);
  });

  it('IP追跡で登録済みの IP は既存扱いで、食い違いなし', () => {
    const c = checkAsset(reg(), 'static', '203.0.113.1');
    expect(c.state).toBe('known');
    expect(c.issue).toBeUndefined();
    expect(assetBadge(c)).toMatchObject({ text: '既存・IP追跡', tone: 'ok' });
  });

  it('静的IP指定なのに既存が DNS 追跡なら食い違いを出す', () => {
    const c = checkAsset(reg(), 'static', '203.0.113.9');
    expect(c.issue).toBe('dns-tracked-ip');
    expect(assetBadge(c).tone).toBe('warn');
    expect(issueLines(c).join('')).toContain('DNS トラッキング');
  });

  it('FQDN 指定なのに既存が IP 追跡なら食い違いを出す', () => {
    const c = checkAsset(reg(), 'dynamic', 'HOST1.example.JP'); // 大文字小文字は無視
    expect(c.state).toBe('known');
    expect(c.issue).toBe('ip-tracked-fqdn');
    expect(issueLines(c).join('')).toContain('IP トラッキング');
  });

  it('未登録の FQDN は新規', () => {
    expect(checkAsset(reg(), 'dynamic', 'new.example.jp').state).toBe('new');
  });

  it('CIDR・レンジは範囲に入る既存ホストをすべて拾う', () => {
    const c = checkAsset(reg(), 'static', '203.0.113.0/24');
    expect(c.hits.map((h) => h.ip)).toEqual(['203.0.113.1', '203.0.113.9']);
    expect(c.issue).toBe('dns-tracked-ip'); // 1 件でも DNS 追跡があれば警告
    expect(assetBadge(c).text).toBe('既存 2件・IP追跡/DNS追跡');
    // 範囲外は拾わない
    expect(checkAsset(reg(), 'static', '203.0.113.1-203.0.113.5').hits).toHaveLength(1);
  });

  it('書式不正な IP は判定不可（例外にしない）', () => {
    expect(checkAsset(reg(), 'static', '999.1.1.1').state).toBe('unknown');
  });
});

describe('同名の AssetGroup / ドメイン', () => {
  it('取り込み済みにあれば、更新になる旨を取込日つきで返す', () => {
    const lines = existingNameLines(reg(), 'EXT-2026-001(仮)', ['ext-2026-001.jp']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-07-18 取込');
    expect(lines[0]).toContain('更新になります');
    expect(lines[1]).toContain('ドメイン「ext-2026-001.jp」');
  });

  it('無ければ何も出さない', () => {
    expect(existingNameLines(reg(), 'EXT-2026-999(仮)', ['ext-2026-999.jp'])).toEqual([]);
  });
});
