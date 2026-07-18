// 定数・localStorage キー・エンティティ定義。状態は持たない。
import type { QamEntity } from './types';

declare const __QAM_BUILD__: string;
export const BUILD = typeof __QAM_BUILD__ !== 'undefined' ? __QAM_BUILD__ : 'dev';
declare const __QAM_BUILDTIME__: string;
export const BUILDTIME = typeof __QAM_BUILDTIME__ !== 'undefined' ? __QAM_BUILDTIME__ : '';

export const RELAY = location.origin; // relay が配信しているので同一オリジン

export const LS = {
  theme: 'qam.theme',
  fontsize: 'qam.fontsize', // 文字サイズ sm/md/lg（既定 md）
  qualysUser: 'qam.qualys.user', // Qualys アカウント（個人設定・ブラウザ保持）
  qualysPass: 'qam.qualys.pass', // Qualys パスワード（env でなくブラウザに保持）
  author: 'qam.author',          // メモ(コメント)/操作履歴の記入者名
  table: (view: string) => `qam.table.${view}`,
};

export const ENTITIES: { key: QamEntity; label: string }[] = [
  { key: 'group', label: 'AssetGroup' },
  { key: 'host', label: 'Host' },
  { key: 'domain', label: 'Domain' },
  { key: 'user', label: 'User' },
];

// 接続点ID: AssetGroup タイトルの先頭〜最初の半角スペースまでを切り出す（形式ルールは設けない）。
// 例: 'AB123 東京拠点ルータ' → 'AB123'。一覧の列表示と四半期検査の対象判定で共有する。
export const settenId = (title: string): string => (title || '').split(' ')[0];

export const today = (): string => new Date().toISOString().slice(0, 10);

// 取込日時スタンプ（ローカル時刻・ファイル名/キー/辞書順ソート可）: 'YYYY-MM-DDTHH-mm-ss'
export function stampNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
// XML の DATETIME(ISO) → 取込日時スタンプ。無効/空なら現在時刻。
// データの時刻を採用することで「同じXML再取込＝同じstamp＝上書き確認」が成立する。
export function datetimeToStamp(iso: string): string {
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      const p = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    }
  }
  return stampNow();
}
// 'YYYY-MM-DDTHH-mm-ss' → 表示用 'YYYY-MM-DD HH:mm:ss'
export const fmtStamp = (s: string): string => (s ? `${s.slice(0, 10)} ${s.slice(11).replace(/-/g, ':')}` : '');
// stamp → 'HH:mm:ss'
export const timeOfStamp = (s: string): string => s.slice(11).replace(/-/g, ':');
