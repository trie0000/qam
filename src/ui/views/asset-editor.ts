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

// FQDN の名前解決の検証結果。unknown=未検証（登録時に警告する）。
export type ResolveState =
  | { status: 'unknown' }
  | { status: 'checking' }
  | { status: 'ok'; addresses: string[] }
  | { status: 'ng'; error: string };
export interface ResolveEntry { value: string; state: ResolveState }

export interface AssetEditor {
  node: HTMLElement;
  read: () => AssetEntry[];
  add: (entries: AssetEntry[]) => void;
  setEnabled: (on: boolean) => void;
  // SCAN 対象のうち、既存ホストとトラッキング方式が食い違うもの。
  // MAP 対象は AssetGroup の ips/dns_names に入れない（ドメイン側で扱う）ので対象外。
  conflicts: () => AssetCheck[];
  // SCAN 対象のうち、名前解決が未検証／失敗のもの（resolve を持つときだけ中身が入る）。
  unresolved: () => ResolveEntry[];
}

export interface AssetEditorOpts {
  hint: string;
  assetType: AssetType;
  mapAllowed: boolean;      // false（動的）なら MAP のチェックを無効化する
  registry: AssetRegistry;
  parse: (raw: string) => TokenParse;
  onInvalid: (bad: string[]) => void;
  onChange: () => void;
  // 名前解決の検証（FQDN のときだけ渡す）。未指定なら検証ボタンを出さない。
  resolve?: (names: string[]) => Promise<{ name: string; ok: boolean; addresses: string[]; error?: string }[]>;
  onError?: (message: string) => void;
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
  // 名前解決の検証結果（値ごと）。行を消しても残さない。
  const resolved = new Map<string, ResolveState>();
  const resolveBtn = el('button', { class: 'btn btn--sm', type: 'button', title: 'DNS で名前解決できるかを確認します（relay 経由）' },
    ['名前解決を検証']) as HTMLButtonElement;
  const head = el('div', { class: 'qam-tok-head', hidden: true }, [
    ...(o.resolve ? [resolveBtn] : []),
    el('span', { class: 'qam-tok-headlbl' }, ['すべて']),
    el('label', { class: 'qam-tok-ck' }, [allMap, el('span', {}, ['MAP'])]),
    el('label', { class: 'qam-tok-ck' }, [allScan, el('span', {}, ['SCAN'])]),
  ]);

  const stateOf = (value: string): ResolveState => resolved.get(value) ?? { status: 'unknown' };

  // 検証結果のバッジ。未検証も「登録時に警告される」ことが分かるよう明示する。
  const resolveBadge = (value: string): HTMLElement => {
    const st = stateOf(value);
    if (st.status === 'ok') {
      // 代表は IPv4 を優先（検査対象は IPv4 のため）。無ければ先頭を出す。
      const head = st.addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? st.addresses[0];
      const rest = st.addresses.length - 1;
      return el('span', { class: 'qam-tok-badge qam-tok-badge--ok', title: `名前解決 OK: ${st.addresses.join(', ')}` },
        [`解決 ${head}${rest > 0 ? ` 他${rest}` : ''}`]);
    }
    if (st.status === 'ng') return el('span', { class: 'qam-tok-badge qam-tok-badge--ng', title: st.error }, ['解決NG']);
    if (st.status === 'checking') return el('span', { class: 'qam-tok-badge qam-tok-badge--muted' }, ['検証中…']);
    return el('span', { class: 'qam-tok-badge qam-tok-badge--muted', title: '「名前解決を検証」で確認できます（未検証のまま登録すると警告します）' }, ['未検証']);
  };

  // 一覧の値をまとめて検証する（relay は単スレッドなので 1 リクエストで送る）。
  const runResolve = async (): Promise<void> => {
    if (!o.resolve || !rows.length) return;
    const names = rows.map((r) => r.value);
    for (const n of names) resolved.set(n, { status: 'checking' });
    resolveBtn.disabled = true;
    draw();
    try {
      const res = await o.resolve(names);
      const seen = new Set<string>();
      for (const r of res) {
        seen.add(r.name);
        resolved.set(r.name, r.ok ? { status: 'ok', addresses: r.addresses } : { status: 'ng', error: r.error || '名前解決できませんでした' });
      }
      // 応答に含まれなかった値は未検証へ戻す（検証中のまま固まらないように）。
      for (const n of names) if (!seen.has(n)) resolved.delete(n);
    } catch (e) {
      for (const n of names) resolved.delete(n);
      o.onError?.((e as Error).message);
    } finally {
      resolveBtn.disabled = false;
      draw();
    }
  };
  resolveBtn.addEventListener('click', () => { void runResolve(); });

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
        ...(o.resolve ? [resolveBadge(r.value)] : []), badgeNode(r.value), ck('map'), ck('scan'),
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
    unresolved: () => (o.resolve
      ? rows.filter((r) => r.scan).map((r) => ({ value: r.value, state: stateOf(r.value) }))
        .filter((e) => e.state.status !== 'ok')
      : []),
  };
}
