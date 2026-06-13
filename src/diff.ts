// 差分エンジン: 前回スナップショットと今回を比較し改廃イベントを生成。
import type { QamEntity, QamEvent, QamRecord, QamRecords } from './types';

function evt(entity: QamEntity, id: string, name: string, change: QamEvent['change'], date: string): QamEvent {
  return { eid: `${entity}:${id}:${date}:_`, ts: date, entity, id, name, change };
}

function fieldDiffs(entity: QamEntity, id: string, name: string, p: QamRecord, c: QamRecord, date: string): QamEvent[] {
  const out: QamEvent[] = [];
  const sKeys = Array.from(new Set([...Object.keys(p.scalar), ...Object.keys(c.scalar)])).sort();
  for (const f of sKeys) {
    const ov = p.scalar[f] ?? '';
    const nv = c.scalar[f] ?? '';
    if (ov !== nv) out.push({ eid: `${entity}:${id}:${date}:${f}`, ts: date, entity, id, name, change: 'modified', field: f, old: ov, new: nv });
  }
  const tKeys = Array.from(new Set([...Object.keys(p.set), ...Object.keys(c.set)])).sort();
  for (const f of tKeys) {
    const ov = p.set[f] ?? [];
    const nv = c.set[f] ?? [];
    const added = nv.filter((x) => !ov.includes(x));
    const removed = ov.filter((x) => !nv.includes(x));
    if (added.length || removed.length) out.push({ eid: `${entity}:${id}:${date}:${f}`, ts: date, entity, id, name, change: 'modified', field: f, added, removed });
  }
  return out;
}

// prev=null（初回 baseline）の呼び出しは想定しない（呼び出し側で baseline は履歴を出さない）。
export function compareSnapshots(prev: QamRecords | null, curr: QamRecords, entity: QamEntity, date: string): QamEvent[] {
  const events: QamEvent[] = [];
  const prevKeys = prev ? Object.keys(prev) : [];
  const currKeys = Object.keys(curr);
  for (const k of currKeys) {
    if (!prev || !(k in prev)) events.push(evt(entity, k, curr[k].name, 'added', date));
  }
  for (const k of prevKeys) {
    if (!(k in curr)) events.push(evt(entity, k, prev![k].name, 'deleted', date));
  }
  for (const k of currKeys) {
    if (prev && k in prev && prev[k].hash !== curr[k].hash) {
      events.push(...fieldDiffs(entity, k, curr[k].name, prev[k], curr[k], date));
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
