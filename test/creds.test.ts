import { describe, it, expect } from 'vitest';
import { needsCredentialPrompt, passwordInputAction } from '../src/creds';

describe('needsCredentialPrompt（取込時に再入力を求めるか）', () => {
  it('暗号文(secret)だけ保存済みなら求めない（平文は持たないのが正常）', () => {
    expect(needsCredentialPrompt({ user: 'u', pass: '', secret: 'ENC' })).toBe(false);
  });
  it('旧バージョンの平文だけでも求めない（互換）', () => {
    expect(needsCredentialPrompt({ user: 'u', pass: 'p' })).toBe(false);
  });
  it('アカウント未設定・パスワード未保存なら求める', () => {
    expect(needsCredentialPrompt({ user: '', pass: '', secret: 'ENC' })).toBe(true);
    expect(needsCredentialPrompt({ user: 'u', pass: '' })).toBe(true);
    expect(needsCredentialPrompt({ user: 'u', pass: '', secret: undefined })).toBe(true);
  });
});

describe('passwordInputAction（設定画面の空欄の意味）', () => {
  it('空欄は「変更なし」。保存済みの認証情報を消さない', () => {
    // 暗号文は画面へ戻せないため、保存済みでも欄は空で開く。ここを「消す」と解釈すると
    // 別項目だけ直して保存したときにパスワードが消え、取込のたびに聞かれる。
    expect(passwordInputAction('')).toBe('keep');
  });
  it('入力があれば保存する', () => {
    expect(passwordInputAction('secret1')).toBe('save');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 判定の重複を禁じるガード。
// パスワードは DPAPI 暗号文(secret)で保存され平文(pass)は空になる。にもかかわらず
// 呼び出し側が独自に `!creds.pass` を見ると「設定済みなのに毎回聞かれる」。
// 実際に取込・ユーザ登録・自動取込の3箇所で取りこぼしたので、ソースを検査して防ぐ。
// Node の型定義はこのプロジェクトに入れていない（ランタイム依存ゼロの方針）。
// vitest は Node 上で動くので実行はできる。読み取りは cwd(プロジェクト直下)基準。
// @ts-expect-error node の型定義を持たないため
import { readFileSync } from 'node:fs';

describe('認証情報の判定は一箇所に集約する（回帰ガード）', () => {
  const main: string = readFileSync('src/main.ts', 'utf8');

  it('main.ts に独自の平文チェック(!creds.pass)を書かない', () => {
    const hits = main.split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter((x) => /!creds\.pass/.test(x.line));
    expect(hits.map((h) => `${h.no}: ${h.line}`)).toEqual([]);
  });

  it('入力を促すモーダルは resolveQualysCreds からだけ呼ぶ（定義を除き1箇所）', () => {
    const calls = main.split('\n').filter((l) => /await promptQualysCreds\(/.test(l));
    expect(calls.length).toBe(1);
  });
});
