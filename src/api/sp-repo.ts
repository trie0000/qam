// RecordRepo の SharePoint リスト実装。
//
// 追記はリストへの POST（SPO が採番するので、複数人が同時に足してもロストアップデートが
// 起きない）。更新は MERGE + If-Match で、412 なら読み直して再適用する。
// ファイル(JSONL)実装が抱えていた「読む→足す→全文書き戻す」の競合はここで解消する。
import { createSpListClient, type SpItem, type SpListClient } from './sp/list';
import { createSpHttp, type SpHttp, type SpHttpOptions } from './sp/http';
import {
  ALL_LISTS, LIST_ANNOTATIONS, LIST_COMMENTS, LIST_INSPECTIONS, LIST_LICENSES, LIST_OPS,
  LIST_SETTINGS, LOCK_INGEST, LIST_RAS_ASSETS, LIST_RAS_TICKETS,
  annotKey, annotToRow, commentToRow, inspectionToRow, licenseToRow, opToRow,
  rowToComment, rowToInspection, rowToLicense, rowToOp,
  rasAssetToRow, rowToRasAsset, rasTicketToRow, rowToRasTicket, rasAssetFields, rasTicketFields,
} from './sp/schema';
import { createSpPermsClient, type SiteGroup, type SpPermsClient } from './sp/perms';
import { buildItemPermPlan, canApplyPerms, pickRoles, type RasAsset, type RasPerms, type RasTicket } from '../ras';
import type { AnnotationUpdate, IngestLock, RecordRepo } from './repo';
import type { QamComment, QamEntity } from '../types';
import type { QamLicenseSample, QamManualInspection, QamOp } from '../store';

const MAX_RETRY = 4;

export interface SpRepoOptions extends SpHttpOptions {
  http?: SpHttp;            // 既に作ってあれば共有する（ダイジェストを使い回す）
  listClient?: SpListClient; // テスト用の差し替え
  permsClient?: SpPermsClient; // テスト用の差し替え
}

// ★読み出す列を手で並べると、列を足したときにここを直し忘れて **その列が永久に空** になる
//   （VulnKind / CveIds で実際に踏んだ）。スキーマから引く。
export const TICKET_FIELDS = ['Title', ...rasTicketFields.map((f) => f.name)];
export const ASSET_FIELDS = ['Title', ...rasAssetFields.map((f) => f.name)];

/** 書き込む内容が同じか。★比較する列を手で選ぶと、選び忘れた列は更新されない。 */
const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createSpRepo(o: SpRepoOptions): RecordRepo & { ensureLists(): Promise<void> } {
  const http = o.http ?? createSpHttp(o);
  const lists = o.listClient ?? createSpListClient({ http });
  // 権限操作はリスト操作と別クライアント（使うのは独自RASの2リストだけ）。
  const permsApi = (): SpPermsClient => (o.permsClient ?? createSpPermsClient(http));
  const now = o.now ?? (() => Date.now());

  // 資産で設定した会社をチケット側へ写す。チケットは資産に紐づく情報しか持たないので、
  // ここで同じ値を持たせないと一覧の表示とアクセス権の判定がずれる。
  // 突き合わせはホストID優先、無ければ IP（host list に居ない資産のチケットは通常無い）。
  async function propagateCompanies(
    assets: { hostId: string; ip: string; businessCompany: string; managementCompany: string }[],
  ): Promise<void> {
    if (!assets.length) return;
    const rows = await lists.all(LIST_RAS_TICKETS, ['Title', 'HostId', 'Ip', 'BusinessCompany', 'ManagementCompany']);
    if (!rows.length) return;
    const byHost = new Map(assets.filter((a) => a.hostId).map((a) => [a.hostId, a]));
    const byIp = new Map(assets.filter((a) => a.ip).map((a) => [a.ip, a]));
    for (const r of rows) {
      const a = byHost.get(String(r.HostId ?? '')) ?? byIp.get(String(r.Ip ?? ''));
      if (!a) continue;
      if (String(r.BusinessCompany ?? '') === a.businessCompany && String(r.ManagementCompany ?? '') === a.managementCompany) continue;
      await lists.update(LIST_RAS_TICKETS, r.Id, { BusinessCompany: a.businessCompany, ManagementCompany: a.managementCompany }, r.__etag);
    }
  }

  // 取込ロック: SettingKey='lock:ingest' の 1 行を claim する。
  // SettingKey に一意制約が張ってあるので、同時に取りに来ても **行を作れるのは 1 人だけ**。
  // 期限切れの行は If-Match 付きの更新で奪う（これも同時なら片方だけ成功する）。
  const lockRow = async (): Promise<SpItem | undefined> =>
    (await lists.all(LIST_SETTINGS, ['SettingKey', 'Value', 'Owner', 'ExpiresAt']))
      .find((r) => String(r.SettingKey ?? '') === LOCK_INGEST);
  const asLock = (r: SpItem): IngestLock =>
    ({ owner: String(r.Owner ?? ''), since: String(r.Value ?? ''), expiresAt: String(r.ExpiresAt ?? '') });
  const alive = (r: SpItem | undefined): boolean => {
    if (!r) return false;
    const exp = Date.parse(String(r.ExpiresAt ?? ''));
    return Number.isFinite(exp) && exp > now();
  };

  // 注釈: 「資産×項目」で 1 行。DedupKey で既存行を引き当て、あれば更新・無ければ追加する。
  async function annotItems(e: QamEntity): Promise<Map<string, SpItem>> {
    const rows = await lists.all(LIST_ANNOTATIONS, ['Entity', 'TargetId', 'FieldName', 'Value', 'DedupKey']);
    const map = new Map<string, SpItem>();
    for (const r of rows) if (String(r.Entity ?? '') === e) map.set(String(r.DedupKey ?? ''), r);
    return map;
  }

  // 1 項目の反映。空文字は「消す」の意味（ファイル実装と同じ）。
  // 他の人が同じ項目を先に触っていれば 412 になるので、読み直して適用し直す。
  async function applyOne(e: QamEntity, u: AnnotationUpdate, cache?: Map<string, SpItem>): Promise<void> {
    const key = annotKey(e, u.id, u.field);
    for (let i = 0; i <= MAX_RETRY; i++) {
      const map = cache && i === 0 ? cache : await annotItems(e);
      const cur = map.get(key);
      if (!u.value) {
        if (cur) await lists.remove(LIST_ANNOTATIONS, cur.Id);
        return;
      }
      if (!cur) {
        try {
          await lists.add(LIST_ANNOTATIONS, annotToRow(e, u.id, u.field, u.value));
          return;
        } catch {
          // 一意制約に弾かれた＝他の人が同時に作った。次周で更新に回る。
          cache?.delete(key);
          continue;
        }
      }
      if (await lists.update(LIST_ANNOTATIONS, cur.Id, { Value: u.value }, cur.__etag)) return;
      cache?.delete(key); // 412 → 最新を読み直す
    }
    throw new Error(`注釈の保存に失敗しました（競合が続いています）: ${u.id} / ${u.field}`);
  }

  return {
    async ensureLists() {
      for (const l of ALL_LISTS) await lists.ensureList(l.title, l.fields, {
        uniqueTitle: l.uniqueTitle, formFormatter: l.formFormatter?.(), dropFields: l.dropFields,
        titleLabel: l.titleLabel, viewFields: l.viewFields, fieldFormatters: l.fieldFormatters,
      });
    },

    async readComments(e, id) {
      const rows = await lists.all(LIST_COMMENTS, ['Entity', 'TargetId', 'Ts', 'RecordedBy', 'Body']);
      return rows.map(rowToComment).filter((c) => (!e || c.entity === e) && (!id || c.id === id));
    },
    addComment: (c: QamComment) => lists.add(LIST_COMMENTS, commentToRow(c)),
    async editComment(e, id, ts, text) {
      // ファイル実装は全文書き戻しだったが、リストでは該当行だけを更新する（他の行に触らない）。
      for (let i = 0; i <= MAX_RETRY; i++) {
        const rows = await lists.all(LIST_COMMENTS, ['Entity', 'TargetId', 'Ts', 'RecordedBy', 'Body']);
        const hit = rows.find((r) => String(r.Entity ?? '') === e && String(r.TargetId ?? '') === id && String(r.Ts ?? '') === ts);
        if (!hit) return; // 見つからなければ何もしない（ファイル実装と同じ）
        if (await lists.update(LIST_COMMENTS, hit.Id, { Body: text }, hit.__etag)) return;
      }
      throw new Error('メモの更新に失敗しました（競合が続いています）');
    },

    async readAnnotations(e) {
      const out: Record<string, Record<string, string>> = {};
      for (const r of (await annotItems(e)).values()) {
        const id = String(r.TargetId ?? '');
        const field = String(r.FieldName ?? '');
        const value = String(r.Value ?? '');
        if (!id || !field || !value) continue;
        (out[id] ??= {})[field] = value;
      }
      return out;
    },
    setAnnotation: (e, id, field, value) => applyOne(e, { id, field, value }),
    async setAnnotationsBulk(e, updates) {
      if (!updates.length) return;
      // 一括取込用。全体を 1 回読んでから 1 件ずつ反映する（行単位なので他の人の分は壊さない）。
      const cache = await annotItems(e);
      for (const u of updates) await applyOne(e, u, cache);
    },

    async readOps(): Promise<QamOp[]> {
      return (await lists.all(LIST_OPS, ['Ts', 'RecordedBy', 'Action', 'Entity', 'Detail'])).map(rowToOp);
    },
    logOp: (op) => lists.add(LIST_OPS, opToRow(op)),

    async readManualInspections(): Promise<QamManualInspection[]> {
      const rows = await lists.all(LIST_INSPECTIONS, [
        'Ts', 'RecordedBy', 'Mode', 'Kind', 'ScheduleTitle', 'NextLaunch', 'AssetGroups', 'Domains',
        'Subject', 'Department', 'Applicant', 'Remarks', 'Provision',
      ]);
      return rows.map(rowToInspection);
    },
    appendManualInspection: (m) => lists.add(LIST_INSPECTIONS, inspectionToRow(m)),

    async readLicenses(): Promise<QamLicenseSample[]> {
      const rows = (await lists.all(LIST_LICENSES, ['Ts', 'Ips', 'Scanned'])).map(rowToLicense);
      // 同一 ts は後勝ち（ips を後から埋めるケースがある）。ファイル実装と同じ正規化。
      const map = new Map<string, QamLicenseSample>();
      for (const r of rows) {
        const cur = map.get(r.ts);
        map.set(r.ts, { ts: r.ts, ips: Math.max(cur?.ips ?? 0, r.ips), scanned: r.scanned || (cur?.scanned ?? 0) });
      }
      return [...map.values()];
    },
    recordLicense: (ts, ips, scanned) => lists.add(LIST_LICENSES, licenseToRow({ ts, ips, scanned })),

    async acquireIngestLock(owner, ttlMin) {
      const cur = await lockRow();
      if (alive(cur)) return asLock(cur!); // 他の人が取込中
      const t = now();
      const row = {
        Title: LOCK_INGEST, SettingKey: LOCK_INGEST, Owner: owner,
        Value: new Date(t).toISOString(), ExpiresAt: new Date(t + Math.max(1, ttlMin) * 60_000).toISOString(),
      };
      if (!cur) {
        try {
          await lists.add(LIST_SETTINGS, row);
          return null;
        } catch {
          // 一意制約で弾かれた＝同時に他の人が取った。誰が持っているかを返す。
          const other = await lockRow();
          return other ? asLock(other) : null;
        }
      }
      // 期限切れの行を引き継ぐ。奪えなければ（412）他の人が先に引き継いだということ。
      if (await lists.update(LIST_SETTINGS, cur.Id, row, cur.__etag)) return null;
      const other = await lockRow();
      return other && alive(other) ? asLock(other) : null;
    },

    async releaseIngestLock(owner) {
      const cur = await lockRow();
      // 期限切れで他の人が引き継いだ後なら、その行は消さない。
      if (cur && String(cur.Owner ?? '') === owner) await lists.remove(LIST_SETTINGS, cur.Id);
    },

    // --- 共有 JSON（設定リストの 1 行）---
    async readSharedJson(key, fallback) {
      const row = (await lists.all(LIST_SETTINGS, ['SettingKey', 'Value']))
        .find((r) => String(r.SettingKey ?? '') === key);
      if (!row) return fallback;
      try { return JSON.parse(String(row.Value ?? '')); } catch { return fallback; }
    },

    async writeSharedJson(key, value) {
      const json = JSON.stringify(value);
      for (let i = 0; i <= MAX_RETRY; i++) {
        const row = (await lists.all(LIST_SETTINGS, ['SettingKey', 'Value']))
          .find((r) => String(r.SettingKey ?? '') === key);
        if (!row) {
          try { await lists.add(LIST_SETTINGS, { Title: key, SettingKey: key, Value: json }); return; }
          catch { continue; } // 一意制約＝同時に他の人が作った。読み直して更新へ回る。
        }
        if (await lists.update(LIST_SETTINGS, row.Id, { Value: json }, row.__etag)) return;
      }
      throw new Error(`共有設定の保存に失敗しました (${key})`);
    },

    // --- 独自RAS ---
    async readRasAssets() {
      const rows = await lists.all(LIST_RAS_ASSETS, ASSET_FIELDS);
      return rows.map(rowToRasAsset);
    },

    async syncRasAssets(assets) {
      const rows = await lists.all(LIST_RAS_ASSETS, ASSET_FIELDS);
      const byKey = new Map(rows.map((r) => [String(r.DedupKey ?? ''), r]));
      let added = 0; let updated = 0; let removed = 0;
      for (const a of assets) {
        const cur = byKey.get(a.key);
        if (!cur) { await lists.add(LIST_RAS_ASSETS, rasAssetToRow(a)); added++; continue; }
        byKey.delete(a.key);
        // 変化が無いなら書かない（毎回の取込で全行を更新すると SP の版数が無駄に増える）。
        // ★チケット側と同じ理由で、比較する列は手で選ばない。
        const same = rowToRasAsset(cur);
        if (sameRow(rasAssetToRow(same), rasAssetToRow(a))) continue;
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, rasAssetToRow(a), cur.__etag)) updated++;
      }
      // Qualys から消えた資産は行も消す（一覧に幽霊が残らないように）。
      for (const left of byKey.values()) { await lists.remove(LIST_RAS_ASSETS, left.Id); removed++; }
      return { added, updated, removed };
    },

    async syncRasAssetsPartial(assets) {
      // 選択同期。★載っていない行は消さない（選ばなかった資産まで消えてしまう）。
      const rows = await lists.all(LIST_RAS_ASSETS, ASSET_FIELDS);
      const byKey = new Map(rows.map((r) => [String(r.DedupKey ?? ''), r]));
      let added = 0; let updated = 0;
      for (const a of assets) {
        const cur = byKey.get(a.key);
        if (!cur) { await lists.add(LIST_RAS_ASSETS, rasAssetToRow(a)); added++; continue; }
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, rasAssetToRow(a), cur.__etag)) updated++;
      }
      return { added, updated };
    },

    async setRasCompany(key, businessCompany, managementCompany) {
      for (let i = 0; i <= MAX_RETRY; i++) {
        const rows = await lists.all(LIST_RAS_ASSETS, ['HostId', 'Ip', 'DedupKey']);
        const cur = rows.find((r) => String(r.DedupKey ?? '') === key);
        if (!cur) throw new Error(`RAS資産が見つかりません (${key})`);
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, { BusinessCompany: businessCompany, ManagementCompany: managementCompany }, cur.__etag)) {
          // ★チケット側にも同じ値を写す。写さないと、資産で直しても次の取込まで
          //   チケット一覧が古いままになり、事業会社に至ってはアクセス権の判定もずれる。
          await propagateCompanies([{ hostId: String(cur.HostId ?? ''), ip: String(cur.Ip ?? ''), businessCompany, managementCompany }]);
          return;
        }
      }
      throw new Error('他の利用者が同じ資産を更新しています。画面を更新してからやり直してください');
    },

    async setRasCompaniesBulk(updates) {
      // 全件を1回だけ読み、行キーで引き当てて必要な分だけ書く。
      const rows = await lists.all(LIST_RAS_ASSETS, ['HostId', 'Ip', 'DedupKey']);
      const byKey = new Map(rows.map((x) => [String(x.DedupKey ?? ''), x]));
      let n = 0;
      const done: { hostId: string; ip: string; businessCompany: string; managementCompany: string }[] = [];
      for (const u of updates) {
        const cur = byKey.get(u.key);
        if (!cur) continue; // 同期のタイミングで消えた資産。取込全体は止めない。
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, { BusinessCompany: u.businessCompany, ManagementCompany: u.managementCompany }, cur.__etag)) {
          n++;
          done.push({ hostId: String(cur.HostId ?? ''), ip: String(cur.Ip ?? ''), businessCompany: u.businessCompany, managementCompany: u.managementCompany });
        }
      }
      // ★チケット側にも写す（資産で直しても次の取込まで古いままになるのを防ぐ）。
      await propagateCompanies(done);
      return n;
    },

    async setRasAssetNote(key, note) {
      for (let i = 0; i <= MAX_RETRY; i++) {
        const rows = await lists.all(LIST_RAS_ASSETS, ['DedupKey']);
        const cur = rows.find((x) => String(x.DedupKey ?? '') === key);
        if (!cur) throw new Error(`RAS資産が見つかりません (${key})`);
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, { Note: note }, cur.__etag)) return;
      }
      throw new Error('他の利用者が同じ資産を更新しています。画面を更新してからやり直してください');
    },

    async readRasTickets() {
      const rows = await lists.all(LIST_RAS_TICKETS, TICKET_FIELDS);
      return rows.map(rowToRasTicket);
    },

    async syncRasTickets(tickets) {
      const rows = await lists.all(LIST_RAS_TICKETS, TICKET_FIELDS);
      // チケット番号は Title（このリストの一意キー）。
      const byKey = new Map(rows.map((r) => [String(r.Title ?? ''), r]));
      let added = 0; let updated = 0; let removed = 0;
      for (const t of tickets) {
        const cur = byKey.get(t.number);
        if (!cur) { await lists.add(LIST_RAS_TICKETS, rasTicketToRow(t)); added++; continue; }
        byKey.delete(t.number);
        const same = rowToRasTicket(cur);
        // ★変化ラベルとレポートリンクは日次更新でしか付けない。同期で毎回上書きすると、
        //   取込のたびにラベルとリンクが消える。渡されていなければ既存値を引き継ぐ。
        const merged = {
          ...t,
          change: t.change ?? same.change, changedAt: t.changedAt ?? same.changedAt,
          reportJa: t.reportJa ?? same.reportJa, reportEn: t.reportEn ?? same.reportEn,
          ticketReportJa: t.ticketReportJa ?? same.ticketReportJa, ticketReportEn: t.ticketReportEn ?? same.ticketReportEn,
          reportZip: t.reportZip ?? same.reportZip, reportedAt: t.reportedAt ?? same.reportedAt,
          note: t.note ?? same.note, // メモは同期で消さない
        };
        // ★比較する列を手で選んでいたため、初回検知日・脆弱性種別・CVE ID だけが
        //   変わった行が「変化なし」と判定されて永久に更新されなかった。
        //   実際に書き込む内容どうしを比べる。
        if (sameRow(rasTicketToRow(same), rasTicketToRow(merged))) continue;
        if (await lists.update(LIST_RAS_TICKETS, cur.Id, rasTicketToRow(merged), cur.__etag)) updated++;
      }
      // ★取得は「直近1ヶ月の変化分」のことがあるので、載っていないチケットは消さない。
      //   消すと、動きが無かっただけのオープン中チケットが毎回消えてしまう。
      return { added, updated, removed };
    },

    async rasListUrls() {
      // 片方が取れなくてももう片方は出す（リンクが出ないだけで、機能は止めない）。
      const [assets, tickets] = await Promise.all([
        lists.viewUrl(LIST_RAS_ASSETS).catch(() => ''),
        lists.viewUrl(LIST_RAS_TICKETS).catch(() => ''),
      ]);
      return { assets, tickets };
    },

    async setRasTicketMarks(marks) {
      if (!marks.length) return 0;
      // 全件を1回だけ読み、チケット番号(Title)で引き当てて必要な分だけ書く。
      const rows = await lists.all(LIST_RAS_TICKETS, ['Title']);
      const byNo = new Map(rows.map((x) => [String(x.Title ?? ''), x]));
      let n = 0;
      for (const m of marks) {
        const cur = byNo.get(m.number);
        if (!cur) continue; // 同期のタイミングで消えた
        const patch: Record<string, unknown> = {};
        if (m.change !== undefined) { patch.ChangeKind = m.change; patch.ChangedAt = m.changedAt ?? ''; }
        if (m.note !== undefined) patch.Note = m.note;
        if (m.reportJa !== undefined) patch.ReportJa = m.reportJa;
        if (m.reportEn !== undefined) patch.ReportEn = m.reportEn;
        if (m.ticketReportJa !== undefined) patch.TicketReportJa = m.ticketReportJa;
        if (m.ticketReportEn !== undefined) patch.TicketReportEn = m.ticketReportEn;
        if (m.reportZip !== undefined) patch.ReportZip = m.reportZip;
        if (m.reportedAt !== undefined) patch.ReportUpdatedAt = m.reportedAt;
        if (!Object.keys(patch).length) continue;
        if (await lists.update(LIST_RAS_TICKETS, cur.Id, patch, cur.__etag)) n++;
      }
      return n;
    },

    listSiteGroups(): Promise<SiteGroup[]> { return permsApi().listSiteGroups(); },

    async applyRasPerms(perms: RasPerms, onProgress) {
      // 管理者グループ未設定のまま継承を解除すると、誰も更新できないアイテムができる。
      if (!canApplyPerms(perms)) throw new Error('管理者グループが未設定です。先に管理者グループを割り当ててください');
      const api = permsApi();
      const roles = pickRoles(await api.roleDefinitions());
      // 実行者がどの管理者グループにも属していなければ、自分の権限だけは残す（ロックアウト防止）。
      const myGroups = new Set(await api.currentUserGroupIds());
      const inAdmin = perms.adminGroupIds.some((g) => myGroups.has(g));
      const keep = inAdmin ? null : await api.currentUserId();

      const targets: { list: string; items: { id: number; businessCompany: string }[] }[] = [
        { list: LIST_RAS_ASSETS, items: (await lists.all(LIST_RAS_ASSETS, ['BusinessCompany'])).map((r) => ({ id: r.Id, businessCompany: String(r.BusinessCompany ?? '') })) },
        { list: LIST_RAS_TICKETS, items: (await lists.all(LIST_RAS_TICKETS, ['BusinessCompany'])).map((r) => ({ id: r.Id, businessCompany: String(r.BusinessCompany ?? '') })) },
      ];
      const total = targets.reduce((n, t) => n + t.items.length, 0);
      let done = 0;
      for (const t of targets) {
        for (const plan of buildItemPermPlan(t.items, perms)) {
          await api.applyItemPerms(t.list, plan, roles, keep);
          onProgress?.(++done, total);
        }
      }
      return { items: total };
    },
  };
}
