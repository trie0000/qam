# Qualys 一覧 XML 構造（パーサの正典）

出典: Qualys 公式ドキュメント（docs.qualys.com）。`qam-ingest.ps1` のパーサはこの構造に合わせる。
実テナント値は伏せ、構造のみを記録。実 URL/テナントは書かない。

## AssetGroup — `/api/2.0/fo/asset/group/?action=list`

DOCTYPE: `ASSET_GROUP_LIST_OUTPUT`。`?show_attributes=ALL` で全項目。

```xml
<ASSET_GROUP_LIST_OUTPUT>
 <RESPONSE>
  <DATETIME>2018-03-17T09:08:01Z</DATETIME>
  <ASSET_GROUP_LIST>
   <ASSET_GROUP>
    <ID>634851</ID>
    <TITLE><![CDATA[mp1]]></TITLE>
    <OWNER_ID>70953</OWNER_ID>
    <UNIT_ID>0</UNIT_ID>
    <NETWORK_ID>0</NETWORK_ID>
    <LAST_UPDATE>2018-03-13T11:44:04Z</LAST_UPDATE>
    <BUSINESS_IMPACT>High</BUSINESS_IMPACT>
    <APPLIANCE_IDS>43576, 43575</APPLIANCE_IDS>
    <IP_SET>
     <IP_RANGE>10.10.10.0-10.10.10.1</IP_RANGE>
     <IP>10.10.10.14</IP>
    </IP_SET>
    <DNS_LIST><DNS>host.example</DNS></DNS_LIST>
    <NETBIOS_LIST><NETBIOS>WIN2003-SRV-O</NETBIOS></NETBIOS_LIST>
    <HOST_IDS>123, 456</HOST_IDS>
    <DOMAIN_LIST><DOMAIN netblock="10.10.10.0, 10.10.25.50">ad.lan</DOMAIN></DOMAIN_LIST>
   </ASSET_GROUP>
  </ASSET_GROUP_LIST>
 </RESPONSE>
</ASSET_GROUP_LIST_OUTPUT>
```
注: v2 はオーナーが `OWNER_ID`（ユーザー名は v1 `asset_group_list.php` の `OWNER`）。
`DNS_LIST`/`HOST_IDS` は属性指定時に出る。`DOMAIN` はテキスト=ドメイン名、`netblock` 属性付き。

## Host — `/api/2.0/fo/asset/host/?action=list`

DOCTYPE: `HOST_LIST_OUTPUT`。`?details=All` で全項目。

```xml
<HOST_LIST_OUTPUT>
 <RESPONSE>
  <DATETIME>...</DATETIME>
  <HOST_LIST>
   <HOST>
    <ID>...</ID>
    <ASSET_ID>...</ASSET_ID>
    <IP>...</IP>
    <TRACKING_METHOD>IP|DNS|NETBIOS|QAGENT...</TRACKING_METHOD>
    <DNS>...</DNS>
    <DNS_DATA><HOSTNAME>..</HOSTNAME><DOMAIN>..</DOMAIN><FQDN>..</FQDN></DNS_DATA>
    <NETBIOS>...</NETBIOS>
    <OS><![CDATA[...]]></OS>
    <QG_HOSTID>...</QG_HOSTID>
    <FIRST_FOUND_DATE>...</FIRST_FOUND_DATE>
    <LAST_VULN_SCAN_DATETIME>...</LAST_VULN_SCAN_DATETIME>
    <LAST_VM_SCANNED_DATE>...</LAST_VM_SCANNED_DATE>
   </HOST>
  </HOST_LIST>
  <WARNING><CODE>1980</CODE><TEXT>1000 record limit exceeded...</TEXT>
   <URL><![CDATA[...&id_min=...]]></URL></WARNING>
 </RESPONSE>
</HOST_LIST_OUTPUT>
```
注: 1000 件超で `WARNING/URL`（`id_min` 付き次バッチ）。Phase 4 の API 直叩きで follow する。
FQDN は `DNS_DATA/FQDN`、無ければ `DNS`。

## Domain — `/api/2.0/fo/asset/domain/?action=list`

ルート `DOMAIN_LIST`（環境により `DOMAIN_LIST_OUTPUT` ラップもあり得るので両対応）。

```xml
<DOMAIN_LIST>
 <DOMAIN>
  <DOMAIN_NAME>example.com</DOMAIN_NAME>
  <DOMAIN_ID>...</DOMAIN_ID>
  <NETWORK><NETWORK_NAME>..</NETWORK_NAME><NETWORK_ID>..</NETWORK_ID></NETWORK>
  <NETBLOCK><RANGE><START>1.2.3.0</START><END>1.2.3.255</END></RANGE></NETBLOCK>
 </DOMAIN>
</DOMAIN_LIST>
```

## User — `POST /qps/rest/2.0/search/am/user/`（QPS RBAC・Basic 認証）

公式: docs.qualys.com の Administration/RBAC API。**`/api/2.0/fo/user/` は存在しない**（403/404 になる）。
旧 `/msp/user_list.php`（USER_LIST_OUTPUT、ASSIGNED_ASSET_GROUPS 付き）は VMDR では access denied で使えない。

- メソッド POST・**末尾スラッシュ必須**・Basic 認証・Content-Type `application/xml`・本文 `<ServiceRequest></ServiceRequest>`（空＝全件）。
- 応答 `ServiceResponse`（XML）。`User` フィールド: `id`/`username`/`firstName`/`lastName`/`emailAddress`/`title`/
  `roleList/list/RoleData/name`（ロール）/`scopeTags/list/TagData/name`（**スコープ=タグ**）。
- 重要: **Active ユーザのみ**返る。スコープは**タグベース**で、**AssetGroup 割当は返らない**（VMDR の RBAC はタグ制御）。
  「どの AssetGroup にアクセス可能か」は新 API では取得不可（旧 MSP の ASSIGNED_ASSET_GROUPS のみが保持していた）。
- キーは `id || username`。

### 参考: 旧 FO/MSP 形式 `USER_LIST_OUTPUT`

```xml
<ServiceResponse>
 <responseCode>SUCCESS</responseCode>
 <count>N</count>
 <data>
  <User>
   <id>12345</id><username>acme_ab1</username>
   <firstName>..</firstName><lastName>..</lastName><title>..</title>
   <emailAddress>..</emailAddress><company>..</company><active>true</active>
   <roleList><UserRole><name>Manager</name></UserRole></roleList>
   <lastLoginDate>..</lastLoginDate>
  </User>
 </data>
</ServiceResponse>
```
注: 要素は camelCase（FO/MSP の `USER_LIST_OUTPUT` とは別）。パーサは `ServiceResponse` を検知して
`<User>` を読む。`responseCode != SUCCESS` は `errorMessage` を出して中断。`User-Agent` を付与（WAF 空応答対策）。
ページングは `hasMoreRecords`/`lastId`（当面は1ページ）。キーは `id || username`。

## User（参考: 旧 FO/MSP 形式）— `USER_LIST_OUTPUT`

DOCTYPE: `USER_LIST_OUTPUT`。`USER_LOGIN`/`USER_ID`/`CONTACT_INFO` 構造。パーサは互換のため引き続き解釈する
（キーは `USER_ID || USER_LOGIN`）。

```xml
<USER_LIST_OUTPUT>
 <USER_LIST>
  <USER>
   <USER_LOGIN>acme_ab1</USER_LOGIN>
   <USER_ID>63</USER_ID>
   <CONTACT_INFO>
    <FIRSTNAME><![CDATA[..]]></FIRSTNAME><LASTNAME><![CDATA[..]]></LASTNAME>
    <TITLE><![CDATA[..]]></TITLE><EMAIL><![CDATA[..]]></EMAIL><COMPANY><![CDATA[..]]></COMPANY>
   </CONTACT_INFO>
   <USER_STATUS>Active</USER_STATUS>
   <USER_ROLE>Manager</USER_ROLE>
   <LAST_LOGIN_DATE>...</LAST_LOGIN_DATE>
  </USER>
 </USER_LIST>
</USER_LIST_OUTPUT>
```
注: DATETIME 無しのため取込日時(stamp)は取込時のローカル時刻にフォールバック。
追跡: USER_LOGIN, NAME(姓 名), EMAIL, TITLE, COMPANY, USER_STATUS, USER_ROLE。info: LAST_LOGIN_DATE（差分対象外）。キー=USER_ID。

## 正規化マッピング（XML → 内部レコード）

| 内部 | AssetGroup | Host | Domain |
|---|---|---|---|
| key | `ID` | `ID` | `DOMAIN_NAME` |
| name | `TITLE` | `DNS_DATA/FQDN` or `DNS` or `IP` | `DOMAIN_NAME` |
| scalar | OWNER_ID, LAST_UPDATE, BUSINESS_IMPACT | IP, NETBIOS, OS, TRACKING_METHOD, LAST_VULN_SCAN_DATETIME | DOMAIN_ID, NETWORK_NAME |
| set | **IPS**(IP+IP_RANGE), **DNS_LIST**(DNS), NETBIOS_LIST, DOMAIN_LIST(DOMAIN), HOST_IDS | — | NETBLOCK(START-END) |

set 項目は差分時に added/removed で表現（DESIGN §2）。
