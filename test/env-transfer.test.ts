import { describe, it, expect } from 'vitest';
import {
  toBundle, applyBundle, normalizeBundle, unresolvedGroupIds, sameOrigin, sameSite, CONFIG_LABEL,
  bundleFileName, TRANSFERABLE_CONFIG_KEYS, BLOCKED_CONFIG_KEYS,
} from '../src/env-transfer';
import type { RasPerms } from '../src/ras';

const DEV_GROUPS = [
  { id: 11, title: 'QAM 管理者' },
  { id: 12, title: 'A事業会社 参照' },
  { id: 13, title: 'B事業会社 参照' },
];
// ★本番は同じ名前でも **ID が違う**。ここがこの機能の肝。
const PROD_GROUPS = [
  { id: 47, title: 'QAM 管理者' },
  { id: 52, title: 'A事業会社 参照' },
  { id: 61, title: 'B事業会社 参照' },
];

const DEV_PERMS: RasPerms = {
  adminGroupIds: [11],
  byBusinessCompany: { A事業会社: [12], B事業会社: [13] },
  aliasesByCompany: { A事業会社: ['AAA'], B事業会社: ['BBB'] },
  contactNameByCompany: { A事業会社: 'A事業' },
};
const EMPTY_PERMS: RasPerms = { adminGroupIds: [], byBusinessCompany: {}, aliasesByCompany: {}, contactNameByCompany: {} };

const DEV_CONFIG: Record<string, unknown> = {
  qualysBase: 'https://qualysapi.example.com', searchListIds: '1,2,3',
  reportTemplateJa: 'TPL-JA', ticketTemplateEn: 'TPL-EN',
  spSiteUrl: 'https://t.example.com/sites/dev', spLibrary: 'QamDataDev', // 環境そのもの。運ばない
  port: 8765, logDir: 'C:/logs', bundleSource: 'sp',                     // qam.env 専用。運ばない
};
const DEV_MAIL = { adhoc: { subject: '件名', body: '本文' } };
const NOW = '2026-08-17T00:00:00.000Z';
const src = { perms: DEV_PERMS, mail: DEV_MAIL, config: DEV_CONFIG };

describe('持ち出し: グループ ID を名前に置き換える', () => {
  it('★アクセス権はグループ名で持ち出す（ID はサイトごとに違うため）', () => {
    const b = toBundle(src, DEV_GROUPS, ['master'], 'https://t.example.com/sites/dev', NOW);
    expect(b.master!.adminGroups).toEqual(['QAM 管理者']);
    expect(b.master!.byBusinessCompany).toEqual({ A事業会社: ['A事業会社 参照'], B事業会社: ['B事業会社 参照'] });
    expect(JSON.stringify(b)).not.toContain('12'); // 数値 ID が混ざっていない
  });

  it('略称と体制表の会社名も一緒に運ぶ', () => {
    const b = toBundle(src, DEV_GROUPS, ['master'], 'dev', NOW);
    expect(b.master!.aliasesByCompany).toEqual({ A事業会社: ['AAA'], B事業会社: ['BBB'] });
    expect(b.master!.contactNameByCompany).toEqual({ A事業会社: 'A事業' });
  });

  it('選ばなかった分は入れない', () => {
    expect(toBundle(src, DEV_GROUPS, ['master'], 'dev', NOW).common).toBeUndefined();
    expect(toBundle(src, DEV_GROUPS, ['common'], 'dev', NOW).master).toBeUndefined();
  });

  it('名前を引けない ID は落とす（持ち込んでも当てられない）', () => {
    const perms = { ...DEV_PERMS, byBusinessCompany: { A事業会社: [12, 999] } };
    const b = toBundle({ ...src, perms }, DEV_GROUPS, ['master'], 'dev', NOW);
    expect(b.master!.byBusinessCompany.A事業会社).toEqual(['A事業会社 参照']);
  });

  it('落ちた ID は名指しで分かるようにする', () => {
    const perms = { ...DEV_PERMS, byBusinessCompany: { A事業会社: [12, 999] }, adminGroupIds: [11, 998] };
    expect(unresolvedGroupIds(perms, DEV_GROUPS)).toEqual([998, 999]);
    expect(unresolvedGroupIds(DEV_PERMS, DEV_GROUPS)).toEqual([]);
  });
});

describe('持ち出し: 共通設定', () => {
  it('★環境そのものを指す設定は運ばない（運ぶと移送先が元環境を向く）', () => {
    const b = toBundle(src, DEV_GROUPS, ['common'], 'dev', NOW);
    for (const k of BLOCKED_CONFIG_KEYS) expect(b.common!.config).not.toHaveProperty(k);
    expect(b.common!.config.spSiteUrl).toBeUndefined();
  });

  it('運ぶ設定には全部ラベルが付いている', () => {
    expect(TRANSFERABLE_CONFIG_KEYS.filter((k) => !CONFIG_LABEL[k])).toEqual([]);
  });

  it('運ぶ設定と運ばない設定は重ならない', () => {
    const t = new Set<string>(TRANSFERABLE_CONFIG_KEYS);
    expect(BLOCKED_CONFIG_KEYS.filter((k) => t.has(k))).toEqual([]);
  });

  it('運べる設定は入る', () => {
    const c = toBundle(src, DEV_GROUPS, ['common'], 'dev', NOW).common!.config;
    expect(c.searchListIds).toBe('1,2,3');
    expect(c.reportTemplateJa).toBe('TPL-JA');
  });

  it('メールのテンプレートも共通設定として運ぶ', () => {
    expect(toBundle(src, DEV_GROUPS, ['common'], 'dev', NOW).common!.mail).toEqual(DEV_MAIL);
  });
});

describe('持ち込み: グループ名を移送先の ID に引き直す', () => {
  const bundle = () => toBundle(src, DEV_GROUPS, ['master', 'common'], 'https://t.example.com/sites/dev', NOW);

  it('★同じ名前でも移送先の ID になる（ここを間違えると別のグループに権限が付く）', () => {
    const r = applyBundle({ perms: EMPTY_PERMS, mail: null, config: {} }, bundle(), PROD_GROUPS, ['master']);
    expect(r.perms.adminGroupIds).toEqual([47]);
    expect(r.perms.byBusinessCompany).toEqual({ A事業会社: [52], B事業会社: [61] });
  });

  it('移送先に無いグループは名指しで報告し、割当は空にする', () => {
    const r = applyBundle({ perms: EMPTY_PERMS, mail: null, config: {} }, bundle(), [PROD_GROUPS[0]], ['master']);
    expect(r.missingGroups).toEqual(['A事業会社 参照', 'B事業会社 参照']);
    expect(r.perms.byBusinessCompany).toEqual({ A事業会社: [], B事業会社: [] });
  });

  it('大小・前後空白が違っても引き当てる', () => {
    const r = applyBundle({ perms: EMPTY_PERMS, mail: null, config: {} }, bundle(),
      [{ id: 70, title: '  qam 管理者 ' }], ['master']);
    expect(r.perms.adminGroupIds).toEqual([70]);
  });

  it('選んでいない分は触らない', () => {
    const cur = { perms: DEV_PERMS, mail: DEV_MAIL, config: DEV_CONFIG };
    const r = applyBundle(cur, bundle(), PROD_GROUPS, ['common']);
    expect(r.perms.byBusinessCompany).toEqual(DEV_PERMS.byBusinessCompany); // master は据え置き
  });

  it('中継サーバの設定は「変わるものだけ」を返す（無駄な書き込みをしない）', () => {
    const cur = { perms: EMPTY_PERMS, mail: DEV_MAIL, config: { ...DEV_CONFIG, searchListIds: '9' } };
    const r = applyBundle(cur, bundle(), PROD_GROUPS, ['common']);
    expect(Object.keys(r.config)).toEqual(['searchListIds']);
    expect(r.config.searchListIds).toBe('1,2,3');
    // ★差分はキー名ではなく画面と同じ言葉で出す（見て気づけないと意味がない）。
    expect(r.changes.map((c) => c.field)).toEqual(['検索リストID']);
  });

  it('★保管先の設定は持ち込み側でも入らない', () => {
    const r = applyBundle({ perms: EMPTY_PERMS, mail: null, config: {} }, bundle(), PROD_GROUPS, ['common']);
    for (const k of BLOCKED_CONFIG_KEYS) expect(r.config).not.toHaveProperty(k);
  });

  it('差分は実行前に見えるようにする', () => {
    const r = applyBundle({ perms: EMPTY_PERMS, mail: null, config: {} }, bundle(), PROD_GROUPS, ['master']);
    expect(r.changes.map((c) => c.field)).toContain('事業会社');
    expect(r.changes.length).toBeGreaterThan(0);
  });

  it('同じ内容なら差分は出ない（押しても何も起きないのを分からせる）', () => {
    const cur = { perms: EMPTY_PERMS, mail: null, config: {} };
    const applied = applyBundle(cur, bundle(), PROD_GROUPS, ['master']);
    const again = applyBundle({ ...cur, perms: applied.perms }, bundle(), PROD_GROUPS, ['master']);
    expect(again.changes).toEqual([]);
  });
});

describe('ファイルの読み込み', () => {
  it('版が違うものは受け付けない', () => {
    expect(normalizeBundle({ version: 2 })).toBeNull();
    expect(normalizeBundle(null)).toBeNull();
    expect(normalizeBundle('x')).toBeNull();
  });

  it('★手で書き足された保管先の設定は捨てる（ファイルは編集できる）', () => {
    const b = normalizeBundle({
      version: 1, exportedAt: NOW, sourceSite: 'dev',
      common: { config: { searchListIds: '1', spSiteUrl: 'https://evil.example.com/sites/x', logDir: 'C:/' }, mail: null },
    });
    expect(b!.common!.config).toEqual({ searchListIds: '1' });
  });

  it('壊れた中身でも落ちない', () => {
    const b = normalizeBundle({ version: 1, master: { adminGroups: 'not-an-array', byBusinessCompany: 5 } });
    expect(b!.master!.adminGroups).toEqual([]);
    expect(b!.master!.byBusinessCompany).toEqual({});
  });

  it('書き出したものをそのまま読み戻せる', () => {
    const b = toBundle(src, DEV_GROUPS, ['master', 'common'], 'dev', NOW);
    expect(normalizeBundle(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });
});

describe('サイトの判定', () => {
  it('同じテナントなら直接コピーできる', () => {
    expect(sameOrigin('https://t.example.com/sites/dev', 'https://t.example.com/sites/prod')).toBe(true);
    expect(sameOrigin('https://a.example.com/sites/dev', 'https://b.example.com/sites/prod')).toBe(false);
    expect(sameOrigin('', 'https://t.example.com')).toBe(false);
  });

  it('★同じサイトを指していたら止める（自分自身へのコピーは無意味）', () => {
    expect(sameSite('https://t.example.com/sites/dev', 'https://T.example.com/sites/DEV/')).toBe(true);
    expect(sameSite('https://t.example.com/sites/dev', 'https://t.example.com/sites/prod')).toBe(false);
    expect(sameSite('', '')).toBe(false);
  });

  it('ファイル名に日時と中身が入る', () => {
    expect(bundleFileName(['master', 'common'], NOW)).toBe('qam-settings-master+common-20260817-000000.json');
  });
});
