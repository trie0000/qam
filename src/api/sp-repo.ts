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
  rasAssetToRow, rowToRasAsset, rasTicketToRow, rowToRasTicket,
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

export function createSpRepo(o: SpRepoOptions): RecordRepo & { ensureLists(): Promise<void> } {
  const http = o.http ?? createSpHttp(o);
  const lists = o.listClient ?? createSpListClient({ http });
  // 権限操作はリスト操作と別クライアント（使うのは独自RASの2リストだけ）。
  const permsApi = (): SpPermsClient => (o.permsClient ?? createSpPermsClient(http));
  const now = o.now ?? (() => Date.now());

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
      for (const l of ALL_LISTS) await lists.ensureList(l.title, l.fields);
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
      const rows = await lists.all(LIST_RAS_ASSETS, ['HostId', 'SettenId', 'Ip', 'Fqdn', 'AliveStatus', 'BusinessCompany', 'ManagementCompany', 'DedupKey']);
      return rows.map(rowToRasAsset);
    },

    async syncRasAssets(assets) {
      const rows = await lists.all(LIST_RAS_ASSETS, ['HostId', 'SettenId', 'Ip', 'Fqdn', 'AliveStatus', 'BusinessCompany', 'ManagementCompany', 'DedupKey']);
      const byKey = new Map(rows.map((r) => [String(r.DedupKey ?? ''), r]));
      let added = 0; let updated = 0; let removed = 0;
      for (const a of assets) {
        const cur = byKey.get(a.key);
        if (!cur) { await lists.add(LIST_RAS_ASSETS, rasAssetToRow(a)); added++; continue; }
        byKey.delete(a.key);
        // 変化が無いなら書かない（毎回の取込で全行を更新すると SP の版数が無駄に増える）。
        const same = rowToRasAsset(cur);
        if (same.settenId === a.settenId && same.ip === a.ip && same.fqdn === a.fqdn && same.status === a.status
          && same.businessCompany === a.businessCompany && same.managementCompany === a.managementCompany) continue;
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, rasAssetToRow(a), cur.__etag)) updated++;
      }
      // Qualys から消えた資産は行も消す（一覧に幽霊が残らないように）。
      for (const left of byKey.values()) { await lists.remove(LIST_RAS_ASSETS, left.Id); removed++; }
      return { added, updated, removed };
    },

    async setRasCompany(key, businessCompany, managementCompany) {
      for (let i = 0; i <= MAX_RETRY; i++) {
        const rows = await lists.all(LIST_RAS_ASSETS, ['HostId', 'DedupKey']);
        const cur = rows.find((r) => String(r.DedupKey ?? '') === key);
        if (!cur) throw new Error(`RAS資産が見つかりません (${key})`);
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, { BusinessCompany: businessCompany, ManagementCompany: managementCompany }, cur.__etag)) return;
      }
      throw new Error('他の利用者が同じ資産を更新しています。画面を更新してからやり直してください');
    },

    async setRasCompaniesBulk(updates) {
      // 全件を1回だけ読み、行キーで引き当てて必要な分だけ書く。
      const rows = await lists.all(LIST_RAS_ASSETS, ['HostId', 'DedupKey']);
      const byKey = new Map(rows.map((x) => [String(x.DedupKey ?? ''), x]));
      let n = 0;
      for (const u of updates) {
        const cur = byKey.get(u.key);
        if (!cur) continue; // 同期のタイミングで消えた資産。取込全体は止めない。
        if (await lists.update(LIST_RAS_ASSETS, cur.Id, { BusinessCompany: u.businessCompany, ManagementCompany: u.managementCompany }, cur.__etag)) n++;
      }
      return n;
    },

    async readRasTickets() {
      const rows = await lists.all(LIST_RAS_TICKETS, ['TicketNumber', 'State', 'HostId', 'Ip', 'Fqdn', 'SettenId', 'BusinessCompany', 'OpenedAt', 'DedupKey']);
      return rows.map(rowToRasTicket);
    },

    async syncRasTickets(tickets) {
      const rows = await lists.all(LIST_RAS_TICKETS, ['TicketNumber', 'State', 'HostId', 'Ip', 'Fqdn', 'SettenId', 'BusinessCompany', 'OpenedAt', 'DedupKey']);
      const byKey = new Map(rows.map((r) => [String(r.DedupKey ?? ''), r]));
      let added = 0; let updated = 0; let removed = 0;
      for (const t of tickets) {
        const cur = byKey.get(t.number);
        if (!cur) { await lists.add(LIST_RAS_TICKETS, rasTicketToRow(t)); added++; continue; }
        byKey.delete(t.number);
        const same = rowToRasTicket(cur);
        if (same.state === t.state && same.businessCompany === t.businessCompany
          && same.ip === t.ip && same.fqdn === t.fqdn && same.settenId === t.settenId) continue;
        if (await lists.update(LIST_RAS_TICKETS, cur.Id, rasTicketToRow(t), cur.__etag)) updated++;
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
