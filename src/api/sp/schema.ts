// SharePoint リストの定義（名前・列）と、QAM の型との相互変換。
// 既存サイトへ相乗りするので、リスト名はすべて `Qam` プレフィックスで衝突を避ける。
//
// 列名は空白を含まない ASCII にする（内部名が _x0020_ 化されず、表示名と一致するため）。
// SCHEMA_VERSION は列を足したときに上げる（ensureLists の再実行判定に使う）。
import type { FieldSpec } from './list';
import type { QamComment, QamEntity } from '../../types';
import type { QamLicenseSample, QamManualInspection, QamOp } from '../../store';

export const SCHEMA_VERSION = 1;

export const LIST_COMMENTS = 'QamComments';
export const LIST_ANNOTATIONS = 'QamAnnotations';
export const LIST_OPS = 'QamOps';
export const LIST_INSPECTIONS = 'QamInspections';
export const LIST_LICENSES = 'QamLicenses';

// Title は SP の必須列。一覧で何の行か分かる値を入れておく（検索・並び替えにも効く）。
export const commentFields: FieldSpec[] = [
  { name: 'Entity', type: 'Text', indexed: true },
  { name: 'TargetId', type: 'Text', indexed: true },
  { name: 'Ts', type: 'Text' },
  { name: 'Author', type: 'Text' },
  { name: 'Body', type: 'Note' },
];

// 注釈は「資産×項目」で1行。同じ組が二重に増えないよう DedupKey に一意制約を張る。
export const annotationFields: FieldSpec[] = [
  { name: 'Entity', type: 'Text', indexed: true },
  { name: 'TargetId', type: 'Text', indexed: true },
  { name: 'FieldName', type: 'Text' },
  { name: 'Value', type: 'Note' },
  { name: 'DedupKey', type: 'Text', indexed: true, enforceUnique: true },
];

export const opFields: FieldSpec[] = [
  { name: 'Ts', type: 'Text', indexed: true },
  { name: 'Author', type: 'Text' },
  { name: 'Action', type: 'Text' },
  { name: 'Entity', type: 'Text' },
  { name: 'Detail', type: 'Note' },
];

export const inspectionFields: FieldSpec[] = [
  { name: 'Ts', type: 'Text', indexed: true },
  { name: 'Author', type: 'Text' },
  { name: 'Mode', type: 'Text' },
  { name: 'Kind', type: 'Text' },
  { name: 'ScheduleTitle', type: 'Text' },
  { name: 'NextLaunch', type: 'Text' },
  { name: 'AssetGroups', type: 'Note' },
  { name: 'Domains', type: 'Note' },
  { name: 'Subject', type: 'Note' },
  { name: 'Department', type: 'Text' },
  { name: 'Applicant', type: 'Text' },
  { name: 'Remarks', type: 'Note' },
  { name: 'Provision', type: 'Note' }, // 再登録のプリフィル用（ProvisionInput の JSON）
];

export const licenseFields: FieldSpec[] = [
  { name: 'Ts', type: 'Text', indexed: true },
  { name: 'Ips', type: 'Number' },
  { name: 'Scanned', type: 'Number' },
];

export const ALL_LISTS: { title: string; fields: FieldSpec[] }[] = [
  { title: LIST_COMMENTS, fields: commentFields },
  { title: LIST_ANNOTATIONS, fields: annotationFields },
  { title: LIST_OPS, fields: opFields },
  { title: LIST_INSPECTIONS, fields: inspectionFields },
  { title: LIST_LICENSES, fields: licenseFields },
];

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// 配列は Note 列に改行区切りで持つ（SP の一覧でもそのまま読める）。
const packList = (a: string[]): string => a.join('\n');
const unpackList = (v: unknown): string[] => str(v).split('\n').map((s) => s.trim()).filter(Boolean);

// --- comments ---
export const commentToRow = (c: QamComment): Record<string, unknown> =>
  ({ Title: c.id, Entity: c.entity, TargetId: c.id, Ts: c.ts, Author: c.author, Body: c.text });
export const rowToComment = (r: Record<string, unknown>): QamComment =>
  ({ ts: str(r.Ts), entity: str(r.Entity) as QamEntity, id: str(r.TargetId), author: str(r.Author), text: str(r.Body) });

// --- annotations ---
export const annotKey = (e: QamEntity, id: string, field: string): string => `${e}|${id}|${field}`;
export const annotToRow = (e: QamEntity, id: string, field: string, value: string): Record<string, unknown> =>
  ({ Title: id, Entity: e, TargetId: id, FieldName: field, Value: value, DedupKey: annotKey(e, id, field) });

// --- ops ---
export const opToRow = (o: QamOp): Record<string, unknown> =>
  ({ Title: o.action, Ts: o.ts, Author: o.author, Action: o.action, Entity: o.entity ?? '', Detail: o.detail });
export const rowToOp = (r: Record<string, unknown>): QamOp => {
  const entity = str(r.Entity);
  return { ts: str(r.Ts), author: str(r.Author), action: str(r.Action), detail: str(r.Detail), ...(entity ? { entity: entity as QamEntity } : {}) };
};

// --- 簡易検査の管理表 ---
export function inspectionToRow(m: QamManualInspection): Record<string, unknown> {
  return {
    Title: m.title, Ts: m.ts, Author: m.author, Mode: m.mode, Kind: m.kind,
    ScheduleTitle: m.title, NextLaunch: m.nextLaunch,
    AssetGroups: packList(m.assetGroups), Domains: packList(m.domains),
    Subject: m.subject ?? '', Department: m.department ?? '', Applicant: m.applicant ?? '',
    Remarks: m.note ?? '', Provision: m.provision ? JSON.stringify(m.provision) : '',
  };
}
export function rowToInspection(r: Record<string, unknown>): QamManualInspection {
  let provision: unknown;
  try { provision = r.Provision ? JSON.parse(str(r.Provision)) : undefined; } catch { provision = undefined; }
  return {
    ts: str(r.Ts), author: str(r.Author),
    mode: (str(r.Mode) === 'qualys' ? 'qualys' : 'ledger'),
    kind: (str(r.Kind) === 'map' ? 'map' : 'scan'),
    title: str(r.ScheduleTitle), nextLaunch: str(r.NextLaunch),
    assetGroups: unpackList(r.AssetGroups), domains: unpackList(r.Domains),
    subject: str(r.Subject) || undefined, department: str(r.Department) || undefined,
    applicant: str(r.Applicant) || undefined, note: str(r.Remarks) || undefined,
    ...(provision === undefined ? {} : { provision }),
  };
}

// --- ライセンス推移 ---
export const licenseToRow = (s: QamLicenseSample): Record<string, unknown> =>
  ({ Title: s.ts, Ts: s.ts, Ips: s.ips, Scanned: s.scanned });
export const rowToLicense = (r: Record<string, unknown>): QamLicenseSample =>
  ({ ts: str(r.Ts), ips: num(r.Ips), scanned: num(r.Scanned) });
