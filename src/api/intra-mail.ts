// 中継サーバの「イントラからのファイル取得」「Outlook 下書き」への薄いクライアント。
//
// ★このファイルはアプリに依存しない。中継サーバの base URL を引数で受けるので、
//   別のツールへそのままコピーして使える。
import type { MailDraft } from '../mail';

export interface IntraFetchResult {
  ok: boolean; name?: string; url?: string; bytes?: number; base64?: string; error?: string;
}

export interface IntraFetchInput {
  loginUrl: string; pageUrl: string; uid: string;
  /** 平文パスワード、または中継サーバで復号できる暗号文（secret）。 */
  pass?: string; secret?: string;
  /** ダウンロードするファイル名のパターン（既定は ITSecurity で始まる Excel）。 */
  pattern?: string;
}

const post = async (base: string, path: string, body: unknown): Promise<any> => {
  const r = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

/** イントラにログインして、ページ内の該当ファイルを取ってくる（base64）。 */
export const fetchIntraFile = (base: string, input: IntraFetchInput): Promise<IntraFetchResult> =>
  post(base, '/qam/intra/fetch-file', input);

/**
 * Outlook の下書きを開く。
 * ★送信はしない。中継サーバ側も Display() までしか行わない。
 */
export const openMailDraft = (base: string, draft: MailDraft & { author?: string }): Promise<{ ok: boolean; error?: string }> =>
  post(base, '/qam/outlook/draft', draft);
