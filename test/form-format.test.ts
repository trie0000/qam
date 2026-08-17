import { describe, it, expect } from 'vitest';
import { rasAssetFormFormatter, rasTicketFormFormatter } from '../src/api/sp/form-format';
import { rasAssetFields, rasTicketFields, ALL_LISTS, LIST_RAS_ASSETS, LIST_RAS_TICKETS } from '../src/api/sp/schema';

/** 書式 JSON から参照している列名（[$InternalName]）を集める。 */
function referencedFields(json: string): string[] {
  return [...new Set([...json.matchAll(/\[\$([A-Za-z0-9_]+)\]/g)].map((m) => m[1]))].sort();
}

describe('連携用リストのフォーム書式', () => {
  const cases = [
    { name: 'RAS資産', json: rasAssetFormFormatter(), fields: rasAssetFields },
    { name: 'RASチケット', json: rasTicketFormFormatter(), fields: rasTicketFields },
  ];

  it.each(cases)('$name: 参照している列が実在する', ({ json, fields }) => {
    // ★列名を書き間違えても SharePoint はエラーにせず空欄で描画するので、画面を見ても
    //   気付けない。Created → OpenedAt のような改名を取りこぼさないようここで固定する。
    const declared = new Set([...fields.map((f) => f.name), 'Title']); // Title は組み込み列
    const unknown = referencedFields(json).filter((f) => !declared.has(f));
    expect(unknown).toEqual([]);
  });

  it.each(cases)('$name: キーは headerJSONFormatter（header では読まれない）', ({ json }) => {
    const o = JSON.parse(json);
    expect(Object.keys(o)).toEqual(['headerJSONFormatter']);
    expect(o.headerJSONFormatter.elmType).toBe('div');
  });

  it.each(cases)('$name: ルートで縦積み・左寄せを明示する（指定しないとカードが横に並ぶ）', ({ json }) => {
    const style = JSON.parse(json).headerJSONFormatter.style;
    expect(style.display).toBe('flex');
    expect(style['flex-direction']).toBe('column');
    expect(style['text-align']).toBe('left');
  });

  it.each(cases)('$name: 2段組になっている', ({ json }) => {
    const card = JSON.parse(json).headerJSONFormatter.children[0];
    const cols = card.children[1];
    expect(cols.style['flex-direction']).toBe('row');
    expect(cols.children).toHaveLength(2);
    expect(cols.children.every((c: { style: Record<string, string> }) => c.style.flex === '1')).toBe(true);
  });

  it('チケットは Title をチケット番号として使い、同じ値の列を別に持たない', () => {
    const names = rasTicketFields.map((f) => f.name);
    expect(names).not.toContain('TicketNumber');
    expect(names).not.toContain('DedupKey');
    // 一意制約は Title に張る。
    expect(ALL_LISTS.find((l) => l.title === LIST_RAS_TICKETS)?.uniqueTitle).toBe(true);
  });

  it('チケットのカードにホストIDは出さない（担当者は IP / FQDN で特定する）', () => {
    expect(referencedFields(rasTicketFormFormatter())).not.toContain('HostId');
  });

  it('資産は DedupKey を一意キーとして持ち続ける（Title は表示用で一意にできない）', () => {
    const assets = ALL_LISTS.find((l) => l.title === LIST_RAS_ASSETS)!;
    expect(assets.fields.find((f) => f.name === 'DedupKey')?.enforceUnique).toBe(true);
    expect(assets.uniqueTitle).toBeUndefined();
  });

  it('連携用の2リストにだけ書式を付ける（他のリストは素のまま）', () => {
    const withFormat = ALL_LISTS.filter((l) => l.formFormatter).map((l) => l.title).sort();
    expect(withFormat).toEqual([LIST_RAS_ASSETS, LIST_RAS_TICKETS].sort());
  });
});
