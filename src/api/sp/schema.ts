// SharePoint リストの定義（名前・列）と、QAM の型との相互変換。
// 既存サイトへ相乗りするので、リスト名はすべて `Qam` プレフィックスで衝突を避ける。
//
// 列名は空白を含まない ASCII にする（内部名が _x0020_ 化されず、表示名と一致するため）。
// SCHEMA_VERSION は列を足したときに上げる（ensureLists の再実行判定に使う）。
import type { FieldSpec } from './list';
import type { QamComment, QamEntity } from '../../types';
import type { RasAsset, RasTicket } from '../../ras';
import { rasAssetFormFormatter, rasTicketFormFormatter, reportLinkColumnFormat } from './form-format';
import type { QamLicenseSample, QamManualInspection, QamOp } from '../../store';

// 2: Author 列を RecordedBy へ改名（Author は SharePoint 組み込みの User 型列と衝突し、
//    列は作られたことになるのに書き込みだけが 400 で失敗する）
// 3: 独自RAS の資産マスター/チケットのリストを追加
// 4: RAS資産に AliveStatus 列を追加（host not alive の表示）
// 5: RASチケットは Title をチケット番号（一意キー）にし、TicketNumber/DedupKey 列を廃止
// 6: RASチケットに変化ラベル(ChangeKind/ChangedAt)とレポートリンク(ReportJa/ReportEn)を追加
// 7: 初回/最終検知日・登録日/最終検査日・管理会社を追加。Title の表示名と一覧の列順を設定
// 8: メモ(Note)と TrackingMethod を追加（メモは SPO の一覧には出さない）
// 9: チケット一覧にレポートのリンク列を表示
// 10: Ticket(Remediation)レポートのリンク列を追加
// 11: レポート更新日(ReportUpdatedAt)を追加
export const SCHEMA_VERSION = 11;

export const LIST_COMMENTS = 'QamComments';
export const LIST_ANNOTATIONS = 'QamAnnotations';
export const LIST_OPS = 'QamOps';
export const LIST_INSPECTIONS = 'QamInspections';
export const LIST_LICENSES = 'QamLicenses';
export const LIST_SETTINGS = 'QamSettings';
// 独自RAS は事業会社ごとにアイテム単位で参照権限を分けるので、スナップショットではなくリストで持つ。
export const LIST_RAS_ASSETS = 'QamRasAssets';
export const LIST_RAS_TICKETS = 'QamRasTickets';

// Title は SP の必須列。一覧で何の行か分かる値を入れておく（検索・並び替えにも効く）。
export const commentFields: FieldSpec[] = [
  { name: 'Entity', type: 'Text', indexed: true },
  { name: 'TargetId', type: 'Text', indexed: true },
  { name: 'Ts', type: 'Text' },
  { name: 'RecordedBy', type: 'Text' }, // Author は SP 組み込み（作成者・User 型）なので使えない
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
  { name: 'RecordedBy', type: 'Text' },
  { name: 'Action', type: 'Text' },
  { name: 'Entity', type: 'Text' },
  { name: 'Detail', type: 'Note' },
];

export const inspectionFields: FieldSpec[] = [
  { name: 'Ts', type: 'Text', indexed: true },
  { name: 'RecordedBy', type: 'Text' },
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

// 共有設定と「排他クレーム行」を兼ねる。SettingKey の一意制約が、複数人が同時に取りに来ても
// 1 人だけが行を作れる原子的な mutex になる（取込ロックの土台）。
export const settingsFields: FieldSpec[] = [
  { name: 'SettingKey', type: 'Text', indexed: true, enforceUnique: true },
  { name: 'Value', type: 'Note' },
  { name: 'Owner', type: 'Text' },
  { name: 'ExpiresAt', type: 'Text' },
];

// 独自RAS の資産マスター。1資産1行。BusinessCompany がアクセス権の割当キーなので必ず索引を張る。
// DedupKey は hostId（同じ資産が二重に増えないように一意制約）。
export const rasAssetFields: FieldSpec[] = [
  { name: 'HostId', type: 'Text', indexed: true },
  { name: 'SettenId', type: 'Text', indexed: true },
  { name: 'Ip', type: 'Text' },
  { name: 'Fqdn', type: 'Text' },
  // 'Status' は他のリストテンプレート由来の同名列と紛らわしいので避ける（Created で一度踏んだ）。
  { name: 'AliveStatus', type: 'Text' }, // '' | 'host not alive'
  { name: 'TrackingMethod', type: 'Text' }, // IP / DNS / NETBIOS 等
  { name: 'RegisteredAt', type: 'Text' }, // 登録日（JST 表記）
  { name: 'LastScan', type: 'Text' },     // 最終検査日（JST 表記）
  { name: 'BusinessCompany', type: 'Text', indexed: true },
  { name: 'ManagementCompany', type: 'Text' },
  { name: 'Note', type: 'Note' }, // メモ（複数行）。SPO の一覧には出さない
  { name: 'DedupKey', type: 'Text', indexed: true, enforceUnique: true },
];

// 独自RAS 資産で見つかった脆弱性チケット。BusinessCompany は資産から写す
// （このリスト単体でアクセス権を組めるようにするため。結合しないと権限が付けられない）。
// ★チケット番号は Title に入れる（一意キー）。同じ値の列を別に持つと二重管理になる。
export const rasTicketFields: FieldSpec[] = [
  { name: 'State', type: 'Text' },
  { name: 'HostId', type: 'Text', indexed: true },
  { name: 'Ip', type: 'Text' },
  { name: 'Fqdn', type: 'Text' },
  { name: 'SettenId', type: 'Text' },
  { name: 'BusinessCompany', type: 'Text', indexed: true },
  { name: 'ManagementCompany', type: 'Text' },
  { name: 'FirstFound', type: 'Text' }, // 初回検知日（JST 表記）
  { name: 'LastFound', type: 'Text' },  // 最終検知日（JST 表記）
  { name: 'ChangeKind', type: 'Text' }, // '' | new | closed | reopened（日次更新で付ける）
  { name: 'ChangedAt', type: 'Text' },
  { name: 'ReportJa', type: 'Text' },   // SCANレポート(日本語)の SharePoint URL
  { name: 'ReportEn', type: 'Text' },
  { name: 'TicketReportJa', type: 'Text' }, // Ticket(Remediation)レポート
  { name: 'TicketReportEn', type: 'Text' },
  { name: 'ReportUpdatedAt', type: 'Text' }, // レポート更新日（JST 表記）
  { name: 'Note', type: 'Note' },       // メモ（複数行）。SPO の一覧には出さない
];

// uniqueTitle: 組み込みの Title 列に一意制約を張る（Title を一意キーに使うリスト）。
// formFormatter: フォームを読み取り専用の2段組カードにする JSON。
// titleLabel: 組み込み Title 列の表示名（内部名は Title のまま）。
// viewFields: 既定ビューに出す列と、その順番。
export const ALL_LISTS: {
  title: string; fields: FieldSpec[]; uniqueTitle?: boolean; formFormatter?: () => string;
  dropFields?: string[]; titleLabel?: string; viewFields?: string[];
  /** 列ごとの表示書式（内部名 → JSON）。一覧のセルの見せ方を変える。 */
  fieldFormatters?: Record<string, string>;
}[] = [
  { title: LIST_COMMENTS, fields: commentFields },
  { title: LIST_ANNOTATIONS, fields: annotationFields },
  { title: LIST_OPS, fields: opFields },
  { title: LIST_INSPECTIONS, fields: inspectionFields },
  { title: LIST_LICENSES, fields: licenseFields },
  { title: LIST_SETTINGS, fields: settingsFields },
  {
    title: LIST_RAS_ASSETS, fields: rasAssetFields, formFormatter: rasAssetFormFormatter,
    titleLabel: 'Host ID',
    viewFields: ['Title', 'AliveStatus', 'BusinessCompany', 'ManagementCompany', 'Ip', 'Fqdn', 'RegisteredAt', 'LastScan'],
  },
  // TicketNumber は Title と同じ値、DedupKey は Title で代替。旧環境から消す。
  {
    title: LIST_RAS_TICKETS, fields: rasTicketFields, uniqueTitle: true, formFormatter: rasTicketFormFormatter,
    dropFields: ['TicketNumber', 'DedupKey', 'OpenedAt'],
    titleLabel: 'Ticket No',
    viewFields: ['Title', 'State', 'BusinessCompany', 'ManagementCompany', 'Ip', 'Fqdn', 'FirstFound', 'LastFound', 'ReportJa', 'ReportEn', 'TicketReportJa', 'TicketReportEn', 'ReportUpdatedAt'],
    fieldFormatters: {
      ReportJa: reportLinkColumnFormat('ReportJa', 'JP'),
      ReportEn: reportLinkColumnFormat('ReportEn', 'EN'),
      TicketReportJa: reportLinkColumnFormat('TicketReportJa', 'JP'),
      TicketReportEn: reportLinkColumnFormat('TicketReportEn', 'EN'),
    },
  },
];

/** 取込の排他クレーム行のキー。 */
export const LOCK_INGEST = 'lock:ingest';

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// 配列は Note 列に改行区切りで持つ（SP の一覧でもそのまま読める）。
const packList = (a: string[]): string => a.join('\n');
const unpackList = (v: unknown): string[] => str(v).split('\n').map((s) => s.trim()).filter(Boolean);

// --- comments ---
export const commentToRow = (c: QamComment): Record<string, unknown> =>
  ({ Title: c.id, Entity: c.entity, TargetId: c.id, Ts: c.ts, RecordedBy: c.author, Body: c.text });
export const rowToComment = (r: Record<string, unknown>): QamComment =>
  ({ ts: str(r.Ts), entity: str(r.Entity) as QamEntity, id: str(r.TargetId), author: str(r.RecordedBy), text: str(r.Body) });

// --- annotations ---
export const annotKey = (e: QamEntity, id: string, field: string): string => `${e}|${id}|${field}`;
export const annotToRow = (e: QamEntity, id: string, field: string, value: string): Record<string, unknown> =>
  ({ Title: id, Entity: e, TargetId: id, FieldName: field, Value: value, DedupKey: annotKey(e, id, field) });

// --- ops ---
export const opToRow = (o: QamOp): Record<string, unknown> =>
  ({ Title: o.action, Ts: o.ts, RecordedBy: o.author, Action: o.action, Entity: o.entity ?? '', Detail: o.detail });
export const rowToOp = (r: Record<string, unknown>): QamOp => {
  const entity = str(r.Entity);
  return { ts: str(r.Ts), author: str(r.RecordedBy), action: str(r.Action), detail: str(r.Detail), ...(entity ? { entity: entity as QamEntity } : {}) };
};

// --- 簡易検査の管理表 ---
export function inspectionToRow(m: QamManualInspection): Record<string, unknown> {
  return {
    Title: m.title, Ts: m.ts, RecordedBy: m.author, Mode: m.mode, Kind: m.kind,
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
    ts: str(r.Ts), author: str(r.RecordedBy),
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


// --- 独自RAS ---
// DedupKey は行キー（host list 由来はホストID、AssetGroup だけの資産は 'ip:<IP>'）。
// ホストIDだけにすると、host list に居ない資産（host not alive）が一意に持てない。
// Title は Host ID（一覧の見出し列）。host list に居ない資産はホストIDが無いので IP/FQDN で代用する。
export const rasAssetToRow = (a: RasAsset): Record<string, unknown> =>
  ({ Title: a.hostId || a.ip || a.fqdn, HostId: a.hostId, SettenId: a.settenId, Ip: a.ip, Fqdn: a.fqdn, AliveStatus: a.status,
     RegisteredAt: a.registeredAt, LastScan: a.lastScan, TrackingMethod: a.trackingMethod, Note: a.note,
     BusinessCompany: a.businessCompany, ManagementCompany: a.managementCompany, DedupKey: a.key });
export const rowToRasAsset = (r: Record<string, unknown>): RasAsset =>
  ({ key: str(r.DedupKey) || str(r.HostId), hostId: str(r.HostId), settenId: str(r.SettenId),
     ip: str(r.Ip), fqdn: str(r.Fqdn), status: str(r.AliveStatus),
     registeredAt: str(r.RegisteredAt), lastScan: str(r.LastScan), trackingMethod: str(r.TrackingMethod), note: str(r.Note),
     businessCompany: str(r.BusinessCompany), managementCompany: str(r.ManagementCompany) });

// チケット番号は Title。一意制約も Title に張る（uniqueTitle）。
export const rasTicketToRow = (t: RasTicket): Record<string, unknown> =>
  ({ Title: t.number, State: t.state, HostId: t.hostId, Ip: t.ip, Fqdn: t.fqdn,
     SettenId: t.settenId, BusinessCompany: t.businessCompany, ManagementCompany: t.managementCompany,
     FirstFound: t.firstFound, LastFound: t.lastFound,
     ChangeKind: t.change ?? '', ChangedAt: t.changedAt ?? '', ReportJa: t.reportJa ?? '', ReportEn: t.reportEn ?? '',
     TicketReportJa: t.ticketReportJa ?? '', TicketReportEn: t.ticketReportEn ?? '',
     ReportUpdatedAt: t.reportedAt ?? '', Note: t.note ?? '' });
export const rowToRasTicket = (r: Record<string, unknown>): RasTicket =>
  ({ number: str(r.Title), state: str(r.State), hostId: str(r.HostId), ip: str(r.Ip), fqdn: str(r.Fqdn),
     settenId: str(r.SettenId), businessCompany: str(r.BusinessCompany), managementCompany: str(r.ManagementCompany),
     created: str(r.FirstFound), firstFound: str(r.FirstFound), lastFound: str(r.LastFound),
     change: str(r.ChangeKind), changedAt: str(r.ChangedAt), reportJa: str(r.ReportJa), reportEn: str(r.ReportEn),
     ticketReportJa: str(r.TicketReportJa), ticketReportEn: str(r.TicketReportEn),
     reportedAt: str(r.ReportUpdatedAt), note: str(r.Note) });
