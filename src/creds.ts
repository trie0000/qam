// Qualys 認証情報の扱い（保存の可否・再入力の要否）。
// 画面や localStorage には触らない純粋な判定だけを置き、main.ts から使う。
// ここを間違えると「設定で入力済みなのに取込のたびに聞かれる」事故になるのでテストで固定する。

export interface StoredCreds {
  base: string;
  user: string;
  pass: string;       // 旧バージョンの平文（互換のため読むだけ）
  secret?: string;    // DPAPI 暗号文。復号口はブラウザに無い
  proxy: string;
}

/**
 * 取得・登録の直前に認証情報の再入力を求めるか。
 * パスワードは暗号文(secret)で持つのが正なので、**平文が無くても secret があれば求めない**。
 */
export const needsCredentialPrompt = (c: Pick<StoredCreds, 'user' | 'pass' | 'secret'>): boolean =>
  !c.user || !(c.pass || c.secret);

/**
 * 設定画面のパスワード欄の入力をどう扱うか。
 * 暗号文は画面へ戻せないので、保存済みでも欄は空で開く。したがって
 * **空欄は「変更なし」**。ここを「消す」と解釈すると、別項目だけ直して保存したときに
 * 保存済みの認証情報が消える。消したいときは「登録情報のリセット」を使う。
 */
export const passwordInputAction = (input: string): 'save' | 'keep' => (input ? 'save' : 'keep');
