// happy-dom の DOMParser は application/xml を実 XML として扱わず HTML へフォールバックする
// （実ブラウザでは正しく動く）。テストでは正しい XML パーサを DOMParser として注入する。
// @xmldom/xmldom は dev 依存のみ。アプリ本体(parse.ts)はブラウザ標準 DOMParser を使うのでバンドルには入らない。
import { DOMParser } from '@xmldom/xmldom';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).DOMParser = DOMParser;
