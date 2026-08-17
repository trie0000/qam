// メール下書きの組み立て（テンプレート差し込み）。
//
// ★このファイルはアプリに依存しない。別のツールへそのままコピーして使える。
//   宛先・差し込み値・テンプレートを受け取り、下書き 1 通分を返すだけ。
//   実際に Outlook を開くのは中継サーバ側（intra-mail.ps1 の Invoke-OutlookDraft）。

/** テンプレートに差し込める値。呼び出し側が用意する。 */
export type MailVars = Record<string, string>;

export interface MailTemplate {
  subject: string;
  /** 本文（プレーンテキスト）。{{名前}} を差し替える。 */
  body: string;
  cc?: string;
  replyTo?: string;
}

export interface MailDraft {
  to: string;
  subject: string;
  /** 本文（プレーンテキスト）。★HTML では送らない。 */
  body: string;
  cc?: string;
  replyTo?: string;
}

/**
 * {{key}} を差し替える。未知のキーはそのまま残す。
 * ★空文字で潰さない。残っていれば「差し込めていない」と画面で気付けるが、
 *   空にすると文章が静かに欠ける。
 */
export function fillTemplate(text: string, vars: MailVars): string {
  return String(text ?? '').replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** 差し込めなかったキー（画面で知らせるために使う）。 */
export function unresolvedKeys(text: string, vars: MailVars): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) if (!(m[1] in vars)) out.add(m[1]);
  return [...out];
}

/**
 * 下書き 1 通を組み立てる。
 * ★本文はプレーンテキスト。HTML では送らないので、エスケープも <br> 変換も要らない
 *   （値に < や & が入っても、そのままの文字として届く）。
 */
export function buildDraft(to: string[], tpl: MailTemplate, vars: MailVars): MailDraft {
  return {
    to: to.filter(Boolean).join('; '),
    subject: fillTemplate(tpl.subject, vars),
    body: fillTemplate(tpl.body, vars),
    cc: tpl.cc?.trim() || undefined,
    replyTo: tpl.replyTo?.trim() || undefined,
  };
}
