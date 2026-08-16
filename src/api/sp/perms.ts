// SharePoint のアイテム単位アクセス権。独自RAS の2リスト（資産マスター/チケット）に、
// 事業会社ごとの参照権限と管理者のフルコントロールを付けるためだけに使う。
//
// 適用順が重要:
//   継承解除 → **先に付与** → 付与したもの以外を削除
// 先に付与するのが肝。実行者の権限を先に消すと、途中でアイテムを見失って残りが適用できない。
// 個別ユーザ権限は残さない（グループだけで構成する）。ただし実行者がどの管理者グループにも
// 属していない場合だけは自分を残す（自分をロックアウトして直せなくなるのを防ぐ安全弁）。
import { V, errText, q, type SpHttp } from './http';
import type { ItemPermPlan } from '../../ras';

export interface SiteGroup { id: number; title: string }
export interface RoleDef { Id: number; RoleTypeKind: number }

export interface SpPermsClient {
  listSiteGroups(): Promise<SiteGroup[]>;
  roleDefinitions(): Promise<RoleDef[]>;
  /** 現在のユーザが属するサイトグループの ID。 */
  currentUserGroupIds(): Promise<number[]>;
  currentUserId(): Promise<number>;
  /** 1 アイテムへ適用する。付与→不要分の削除、の順。 */
  applyItemPerms(list: string, plan: ItemPermPlan, roles: { read: number; full: number }, keepPrincipalId: number | null): Promise<void>;
}

export function createSpPermsClient(http: SpHttp): SpPermsClient {
  const listApi = (title: string): string => `web/lists/getbytitle('${q(title)}')`;
  const itemApi = (title: string, id: number): string => `${listApi(title)}/items(${id})`;

  const rows = async (r: Response, what: string): Promise<Record<string, unknown>[]> => {
    if (!r.ok) throw new Error(`${what}に失敗: HTTP ${r.status}${await errText(r)}`);
    return ((await http.json(r)).results ?? []) as Record<string, unknown>[];
  };

  return {
    async listSiteGroups() {
      const r = await http.get('web/sitegroups?$select=Id,Title&$top=500');
      return (await rows(r, 'サイトの権限グループ取得'))
        .map((g) => ({ id: Number(g.Id), title: String(g.Title ?? '') }))
        .filter((g) => Number.isInteger(g.id) && g.id > 0)
        .sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    },

    async roleDefinitions() {
      const r = await http.get('web/roledefinitions?$select=Id,RoleTypeKind&$top=100');
      return (await rows(r, 'ロール定義の取得')).map((d) => ({ Id: Number(d.Id), RoleTypeKind: Number(d.RoleTypeKind) }));
    },

    async currentUserGroupIds() {
      const r = await http.get('web/currentuser/groups?$select=Id&$top=500');
      return (await rows(r, '所属グループの取得')).map((g) => Number(g.Id)).filter((n) => Number.isInteger(n));
    },

    async currentUserId() {
      const r = await http.get('web/currentuser?$select=Id');
      if (!r.ok) throw new Error(`ログインユーザの取得に失敗: HTTP ${r.status}${await errText(r)}`);
      return Number((await http.json(r)).Id ?? 0);
    },

    async applyItemPerms(list, plan, roles, keepPrincipalId) {
      const base = itemApi(list, plan.id);
      // 継承は毎回切り直す（既に切れていても 200 で返る）。copyRoleAssignments=false で
      // 親の割当を持ち込まない＝「付けたものだけ」が残る状態から組み直せる。
      const brk = await http.post(`${base}/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=true)`);
      if (!brk.ok) throw new Error(`権限の継承解除に失敗 (${list}#${plan.id}): HTTP ${brk.status}${await errText(brk)}`);

      // 先に付与する。ここを後回しにすると、自分の権限を消した時点で以降が 403 になる。
      const wanted = new Map<number, number>(); // principalId → roleDefId
      for (const g of plan.full) wanted.set(g, roles.full);
      for (const g of plan.read) if (!wanted.has(g)) wanted.set(g, roles.read);
      if (keepPrincipalId) wanted.set(keepPrincipalId, roles.full); // ロックアウト防止
      for (const [pid, rid] of wanted) {
        const add = await http.post(`${base}/roleassignments/addroleassignment(principalid=${pid},roledefid=${rid})`);
        if (!add.ok) throw new Error(`権限の付与に失敗 (${list}#${plan.id} principal=${pid}): HTTP ${add.status}${await errText(add)}`);
      }

      // 付与したもの以外を削除する。継承解除の直後でも、サイト管理者などが自動で入ることがある。
      // ★removeroleassignment は「そのロール定義の割当」しか消さない。principal に付いている
      //   実際のロール（read か full か）を展開して、その ID で消す必要がある
      //   （固定で full を指定すると、read で入っている割当が消えずに残る）。
      const cur = await http.get(`${base}/roleassignments?$select=PrincipalId,RoleDefinitionBindings/Id&$expand=RoleDefinitionBindings&$top=500`);
      for (const ra of await rows(cur, '権限の一覧取得')) {
        const pid = Number(ra.PrincipalId);
        if (!Number.isInteger(pid) || wanted.has(pid)) continue;
        const bindings = ((ra.RoleDefinitionBindings as { results?: { Id?: unknown }[] } | undefined)?.results ?? [])
          .map((b) => Number(b.Id)).filter((n) => Number.isInteger(n) && n > 0);
        for (const rid of bindings) {
          const del = await http.post(`${base}/roleassignments/removeroleassignment(principalid=${pid},roledefid=${rid})`, {
            headers: { 'Content-Type': V },
          });
          // 消せないもの（サイトコレクション管理者など）は SP 側が拒否する。運用を止めない。
          if (!del.ok) console.warn(`[qam/sp] ${list}#${plan.id} の余分な権限を削除できませんでした（続行）: principal=${pid} role=${rid} HTTP ${del.status}`);
        }
      }
    },
  };
}
