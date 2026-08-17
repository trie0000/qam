// 連携用リスト（独自RASの資産マスター / チケット）のフォーム書式。
//
// 事業会社の担当者は SharePoint のリストを直接見る。素のフォームは項目が縦に
// 延々と並んで読みにくいので、読み取り専用の2段組カードで見せる。
//
// ★色・寸法を直値で書いている理由
//   この JSON を描画するのは **SharePoint 自身のフォーム**で、アプリの
//   #qam-root の外側。デザイントークン（var(--...)）は存在しないので
//   SharePoint 標準色に合わせた実値を書く。このファイルだけが例外。
//
// ★書き込み先はコンテンツタイプの ClientFormCustomFormatter で、
//   キーは `headerJSONFormatter`（`header` ではフォームが読まない）。
// ★ルート要素に display:flex / flex-direction:column / text-align:left を
//   明示する。ヘッダー領域は外側で横並び・中央寄せが効いており、指定しないと
//   カードが横に並ぶ。
// ★値の参照は [$内部名]。表示名を変えても内部名は変わらないので書き換え不要。

const COLUMN_FORMAT_SCHEMA = 'https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json';

type Node = Record<string, unknown>;

const LABEL_STYLE = { 'font-size': '11px', 'font-weight': '400', color: '#605e5c', 'padding-bottom': '2px' };
const VALUE_STYLE = { 'font-size': '14px', 'font-weight': '400', color: '#323130', 'word-break': 'break-word' };

/** ラベル（小さめ・グレー）と値を縦に並べた1項目。空値は「—」にする。 */
function item(label: string, field: string): Node {
  return {
    elmType: 'div',
    style: { 'padding-bottom': '10px' },
    children: [
      { elmType: 'div', txtContent: label, style: LABEL_STYLE },
      { elmType: 'div', txtContent: `=if([$${field}] == '', '—', [$${field}])`, style: VALUE_STYLE },
    ],
  };
}

/** 2段組の1列分。flex:1 で等幅にする。min-width:0 が無いと長い値で列幅が崩れる。 */
const column = (children: Node[]): Node =>
  ({ elmType: 'div', style: { flex: '1', 'min-width': '0', padding: '0px' }, children });

const twoColumns = (left: Node[], right: Node[]): Node => ({
  elmType: 'div',
  style: { display: 'flex', 'flex-direction': 'row', 'column-gap': '24px', width: '100%' },
  children: [column(left), column(right)],
});

/** カード1枚。見出し（＝Title 列の値）＋2段組の中身。 */
function card(caption: string, left: Node[], right: Node[]): Node {
  return {
    elmType: 'div',
    style: {
      display: 'flex', 'flex-direction': 'column', 'align-items': 'stretch', 'text-align': 'left',
      width: '100%', 'box-sizing': 'border-box',
      padding: '14px 18px', 'margin-bottom': '10px',
      'border-radius': '8px', border: '1px solid #edebe9', 'background-color': '#faf9f8',
    },
    children: [
      {
        elmType: 'div',
        txtContent: `=('${caption}' + [$Title])`,
        style: {
          'font-size': '13px', 'font-weight': '600', color: '#201f1e',
          'padding-bottom': '8px', 'margin-bottom': '12px', 'border-bottom': '1px solid #edebe9',
        },
      },
      twoColumns(left, right),
    ],
  };
}

const root = (children: Node[]): Node => ({
  $schema: COLUMN_FORMAT_SCHEMA,
  elmType: 'div',
  style: {
    display: 'flex', 'flex-direction': 'column', 'align-items': 'stretch',
    'text-align': 'left', width: '100%', 'box-sizing': 'border-box', padding: '0px',
  },
  children,
});

// 独自RAS 資産マスター。見出しは Title（IP か FQDN）。
export const rasAssetFormFormatter = (): string => JSON.stringify({
  headerJSONFormatter: root([card('資産  ',
    [item('接続点ID', 'SettenId'), item('IP', 'Ip'), item('FQDN', 'Fqdn')],
    [item('ステータス', 'AliveStatus'), item('事業会社', 'BusinessCompany'), item('管理会社', 'ManagementCompany')],
  )]),
});

// 独自RAS チケット。見出しは Title（＝チケット番号）。
// ホストIDは載せない（担当者は IP / FQDN で資産を特定するため）。
export const rasTicketFormFormatter = (): string => JSON.stringify({
  headerJSONFormatter: root([card('チケット #',
    [item('ステータス', 'State'), item('接続点ID', 'SettenId'), item('事業会社', 'BusinessCompany')],
    [item('IP', 'Ip'), item('FQDN', 'Fqdn'), item('オープン日時', 'OpenedAt')],
  )]),
});
