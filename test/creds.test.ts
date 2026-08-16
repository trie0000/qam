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
