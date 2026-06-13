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
