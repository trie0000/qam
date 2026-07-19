// 検査資産情報のエディタ（静的=IP / 動的=FQDN で 1 つずつ使う）。
// テキスト欄に直接入力 →「追加」でリストへ。カンマ・改行区切りは分割して複数行として登録する
// （レンジは展開しない）。書式違反が 1 つでもあれば何も追加せず警告し、入力は残して修正を促す。
// 行ごとに MAP / SCAN のチェックを持ち（両方可）、ヘッダのチェックで全選択/全解除できる。
// 動的（FQDN 指定）は MAP 検査の対象外なので、MAP のチェックは無効化する。
// 各行には取り込み済み host list と突き合わせたバッジを出し、
// 「どれが新規に host list へ追加されるか」「トラッキング方式が食い違っていないか」を登録前に見せる。
import { el, clear } from '../dom';
import { icon } from '../../icons';
import { assetBadge, checkAsset, newHostAssets, type AssetCheck, type AssetRegistry } from '../../precheck';
import type { AssetEntry, AssetType, TokenParse } from '../../provision';

export interface AssetEditor {
  node: HTMLElement;
  read: () => AssetEntry[];
  add: (entries: AssetEntry[]) => void;
  setEnabled: (on: boolean) => void;
  // SCAN 対象のうち、既存ホストとトラッキング方式が食い違うもの。
  // MAP 対象は AssetGroup の ips/dns_names に入れない（ドメイン側で扱う）ので対象外。
  conflicts: () => AssetCheck[];
}

export interface AssetEditorOpts {
  hint: string;
  assetType: AssetType;
  mapAllowed: boolean;      // false（動的）なら MAP のチェックを無効化する
  registry: AssetRegistry;
  parse: (raw: string) => TokenParse;
  onInvalid: (bad: string[]) => void;
  onChange: () => void;
}

export function assetEditor(o: AssetEditorOpts): AssetEditor {
  const rows: AssetEntry[] = [];
  const input = el('textarea', { class: 'in qam-tok-ta', rows: '3', placeholder: o.hint }) as HTMLTextAreaElement;
  const addBtn = el('button', { class: 'btn btn--sm', type: 'button' }, ['追加']);
  const list = el('div', { class: 'qam-tok-list' });
  const foot = el('div', { class: 'qam-tok-foot', hidden: true });
  const MAP_NA = '動的（FQDN 指定）の資産は MAP 検査の対象外です';
  const allMap = el('input', {
    type: 'checkbox', title: o.mapAllowed ? 'すべての資産を MAP 対象にする' : MAP_NA,
  }) as HTMLInputElement;
  allMap.disabled = !o.mapAllowed;
  const allScan = el('input', { type: 'checkbox', title: 'すべての資産を SCAN 対象にする' }) as HTMLInputElement;
  const head = el('div', { class: 'qam-tok-head', hidden: true }, [
    el('span', { class: 'qam-tok-headlbl' }, ['すべて']),
    el('label', { class: 'qam-tok-ck' }, [allMap, el('span', {}, ['MAP'])]),
    el('label', { class: 'qam-tok-ck' }, [allScan, el('span', {}, ['SCAN'])]),
  ]);

  // 同じ値の判定は使い回す（レンジは host 全件の走査になるため）。
  const cache = new Map<string, AssetCheck>();
  const checkOf = (value: string): AssetCheck => {
    const hit = cache.get(value);
    if (hit) return hit;
    const c = checkAsset(o.registry, o.assetType, value);
    cache.set(value, c);
    return c;
  };

  // ヘッダのチェック状態を行の状態に合わせる（全部入っていれば on）。
  const syncHead = (): void => {
    head.hidden = rows.length === 0;
    allMap.checked = o.mapAllowed && rows.length > 0 && rows.every((r) => r.map);
    allScan.checked = rows.length > 0 && rows.every((r) => r.scan);
  };

  // 新規に host list へ登録される見込みの資産を、リストの下にまとめて出す。
  const drawFoot = (): void => {
    foot.hidden = rows.length === 0;
    clear(foot);
    if (!rows.length) return;
    if (!o.registry.stamps.host) {
      foot.append(el('span', { class: 'qam-tok-foot-muted' }, ['host 一覧が未取込のため、新規登録になる資産を判定できません（資産タブで host を取り込むと表示されます）。']));
      return;
    }
    const fresh = newHostAssets(rows.filter((r) => r.scan).map((r) => checkOf(r.value)));
    if (!fresh.length) {
      foot.append(el('span', { class: 'qam-tok-foot-muted' }, ['SCAN 対象はすべて host list に登録済みです。']));
      return;
    }
    foot.append(
      el('span', { class: 'qam-tok-foot-new' }, [`host list へ新規登録される見込み: ${fresh.length} 件`]),
      el('span', { class: 'qam-tok-foot-muted' }, [`（${fresh.map((c) => c.value).join(', ')}）`]),
    );
  };

  const badgeNode = (value: string): HTMLElement => {
    const b = assetBadge(checkOf(value));
    return el('span', { class: `qam-tok-badge qam-tok-badge--${b.tone}`, title: b.title }, [b.text]);
  };

  // notify=false は「呼び出し元が既に再描画中」のとき（setEnabled）。
  // ここで onChange を呼ぶとフォームの refreshAll → setEnabled → draw と無限に回る。
  const draw = (notify = true): void => {
    clear(list);
    rows.forEach((r, idx) => {
      const del = el('button', { class: 'btn btn--icon btn--sm', type: 'button', 'aria-label': `${r.value} を削除`, title: '削除', html: icon('x', 13) });
      del.addEventListener('click', () => { rows.splice(idx, 1); draw(); o.onChange(); });
      const ck = (kind: 'map' | 'scan'): HTMLElement => {
        const na = kind === 'map' && !o.mapAllowed;
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = r[kind] && !na;
        cb.disabled = na;
        cb.addEventListener('change', () => { r[kind] = cb.checked; syncHead(); drawFoot(); o.onChange(); });
        return el('label', { class: `qam-tok-ck${na ? ' qam-tok-ck--na' : ''}`, ...(na ? { title: MAP_NA } : {}) },
          [cb, el('span', {}, [kind === 'map' ? 'MAP' : 'SCAN'])]);
      };
      list.append(el('div', { class: 'qam-tok-item' }, [
        del, el('span', { class: 'qam-tok-val' }, [r.value]), el('span', { class: 'qam-spacer' }),
        badgeNode(r.value), ck('map'), ck('scan'),
      ]));
    });
    syncHead();
    drawFoot();
    if (notify) o.onChange();
  };
  const setAll = (kind: 'scan' | 'map', on: boolean): void => {
    for (const r of rows) r[kind] = on;
    draw();
  };
  allScan.addEventListener('change', () => setAll('scan', allScan.checked));
  allMap.addEventListener('change', () => setAll('map', allMap.checked));

  const commit = (): void => {
    const { tokens, errors } = o.parse(input.value);
    if (errors.length) { o.onInvalid(errors); return; } // 修正できるよう入力は消さない
    // 新規行は既定で SCAN 対象（大半が SCAN のため）。MAP は明示的に選ばせる。
    for (const t of tokens) if (!rows.some((r) => r.value === t)) rows.push({ value: t, scan: true, map: false });
    input.value = '';
    draw();
  };
  addBtn.addEventListener('click', commit);
  // Ctrl/Cmd+Enter で追加（素の Enter は改行として使う）。IME 変換中は無視する。
  input.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });

  const node = el('div', {}, [el('div', { class: 'qam-tok-input' }, [input, addBtn]), head, list, foot]);
  return {
    node,
    read: () => rows.map((r) => ({ ...r })),
    // 古い履歴からのプリフィルで MAP が付いていても、対象外なら落とす。
    add: (init) => {
      for (const a of init) {
        if (!a.value || rows.some((r) => r.value === a.value)) continue;
        rows.push({ ...a, map: a.map && o.mapAllowed });
      }
      draw();
    },
    // 資産種別で使わない側は入力自体を止める（見えていても打てない状態にしない）。
    setEnabled: (on) => {
      input.disabled = !on;
      addBtn.toggleAttribute('disabled', !on);
      if (!on) { rows.length = 0; input.value = ''; draw(false); } // 使わない入力は残さない
    },
    conflicts: () => rows.filter((r) => r.scan).map((r) => checkOf(r.value)).filter((c) => !!c.issue),
  };
}
