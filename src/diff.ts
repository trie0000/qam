// 差分エンジン: 前回スナップショットと今回を比較し改廃イベントを生成。
import type { QamEntity, QamEvent, QamRecord, QamRecords } from './types';

// 改廃の「更新日(ts)」に使う、資産ごとの更新時刻フィールド（XML上の値）。
// AssetGroup は LAST_UPDATE。host/domain/user は XML に妥当な「更新時刻」が無いため取込時刻にフォールバック。
const UPDATE_FIELD: Partial<Record<QamEntity, string>> = { group: 'LAST_UPDATE' };

// ISO(例 2024-06-13T08:30:00Z) → 取込スタンプ同形式 'YYYY-MM-DDTHH-mm-ss'（ローカル時刻・既存スタンプと同基準）。
// 無効/空は ''（呼び出し側で取込スタンプにフォールバック）。
function isoToStamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ingestStamp: 取込スタンプ（eid と上書き判定に使う）。ts: 表示/絞り込み用の更新日（XML更新時刻 or 取込時刻）。
function evt(entity: QamEntity, id: string, name: string, change: QamEvent['change'], ingestStamp: string, ts: string): QamEvent {
  return { eid: `${entity}:${id}:${ingestStamp}:_`, ts, ingestStamp, entity, id, name, change };
}

// 削除直前の資産プロパティを表示用に平坦化（name→scalar→set(カンマ結合)→info、空値は除外）。
function recordProps(rec: QamRecord): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  if (rec.name) out.push({ k: 'name', v: rec.name });
  for (const k of Object.keys(rec.scalar)) out.push({ k, v: rec.scalar[k] ?? '' });
  for (const k of Object.keys(rec.set)) out.push({ k, v: (rec.set[k] ?? []).join(', ') });
  for (const k of Object.keys(rec.info)) out.push({ k, v: rec.info[k] ?? '' });
  return out.filter((p) => p.v !== '');
}

function fieldDiffs(entity: QamEntity, id: string, name: string, p: QamRecord, c: QamRecord, ingestStamp: string, ts: string): QamEvent[] {
  const out: QamEvent[] = [];
  const base = { ts, ingestStamp, entity, id, name, change: 'modified' as const };
  const sKeys = Array.from(new Set([...Object.keys(p.scalar), ...Object.keys(c.scalar)])).sort();
  for (const f of sKeys) {
    const ov = p.scalar[f] ?? '';
    const nv = c.scalar[f] ?? '';
    if (ov !== nv) out.push({ eid: `${entity}:${id}:${ingestStamp}:${f}`, ...base, field: f, old: ov, new: nv });
  }
  const tKeys = Array.from(new Set([...Object.keys(p.set), ...Object.keys(c.set)])).sort();
  for (const f of tKeys) {
    const ov = p.set[f] ?? [];
    const nv = c.set[f] ?? [];
    const added = nv.filter((x) => !ov.includes(x));
    const removed = ov.filter((x) => !nv.includes(x));
    if (added.length || removed.length) out.push({ eid: `${entity}:${id}:${ingestStamp}:${f}`, ...base, field: f, added, removed });
  }
  return out;
}

// prev=null（初回 baseline）の呼び出しは想定しない（呼び出し側で baseline は履歴を出さない）。
// stamp = 取込スタンプ。更新日(ts) は XML の更新時刻（AssetGroup=LAST_UPDATE 等）を優先し、無ければ取込スタンプ。
export function compareSnapshots(prev: QamRecords | null, curr: QamRecords, entity: QamEntity, stamp: string): QamEvent[] {
  const events: QamEvent[] = [];
  const upField = UPDATE_FIELD[entity];
  const tsOf = (rec: QamRecord): string => (upField ? isoToStamp(rec.info[upField] ?? '') : '') || stamp;
  const prevKeys = prev ? Object.keys(prev) : [];
  const currKeys = Object.keys(curr);
  for (const k of currKeys) {
    if (!prev || !(k in prev)) { const e = evt(entity, k, curr[k].name, 'added', stamp, tsOf(curr[k])); e.props = recordProps(curr[k]); events.push(e); }
  }
  for (const k of prevKeys) {
    // 削除は XML に該当レコードが無い＝更新時刻が取れないため、検出した取込時刻を更新日にする。
    if (!(k in curr)) { const e = evt(entity, k, prev![k].name, 'deleted', stamp, stamp); e.props = recordProps(prev![k]); events.push(e); }
  }
  for (const k of currKeys) {
    if (prev && k in prev && prev[k].hash !== curr[k].hash) {
      events.push(...fieldDiffs(entity, k, curr[k].name, prev[k], curr[k], stamp, tsOf(curr[k])));
    }
  }
  return events;
}

// 件数急減ガード: 前回比で ratio 以上に減った（または 0 件）なら true（確定前に要確認）。
export function shrinkGuard(prevCount: number, currCount: number, ratio: number): boolean {
  if (prevCount <= 0) return false;
  if (currCount <= 0) return true;
  return (prevCount - currCount) / prevCount >= ratio;
}

export function countByChange(events: QamEvent[], change: QamEvent['change']): number {
  return events.filter((e) => e.change === change).length;
}
