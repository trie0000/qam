// 定数・localStorage キー・エンティティ定義。状態は持たない。
import type { QamEntity } from './types';

declare const __QAM_BUILD__: string;
export const BUILD = typeof __QAM_BUILD__ !== 'undefined' ? __QAM_BUILD__ : 'dev';

export const RELAY = location.origin; // relay が配信しているので同一オリジン

export const LS = {
  theme: 'qam.theme',
  qualysPass: 'qam.qualys.pass', // パスワードは env でなくブラウザに保持
  table: (view: string) => `qam.table.${view}`,
};

export const ENTITIES: { key: QamEntity; label: string }[] = [
  { key: 'group', label: 'AssetGroup' },
  { key: 'host', label: 'Host' },
  { key: 'domain', label: 'Domain' },
];

export const today = (): string => new Date().toISOString().slice(0, 10);

// 取込日時スタンプ（ローカル時刻・ファイル名/キー/辞書順ソート可）: 'YYYY-MM-DDTHH-mm-ss'
export function stampNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
// 'YYYY-MM-DDTHH-mm-ss' → 表示用 'YYYY-MM-DD HH:mm:ss'
export const fmtStamp = (s: string): string => (s ? `${s.slice(0, 10)} ${s.slice(11).replace(/-/g, ':')}` : '');
// stamp → 'HH:mm:ss'
export const timeOfStamp = (s: string): string => s.slice(11).replace(/-/g, ':');
