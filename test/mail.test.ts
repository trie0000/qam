import { describe, it, expect } from 'vitest';
import { fillTemplate, unresolvedKeys, buildDraft } from '../src/mail';

describe('メールテンプレートの差し込み', () => {
  it('{{キー}} を差し替える', () => {
    expect(fillTemplate('{{company}} 御中', { company: 'A事業会社' })).toBe('A事業会社 御中');
  });

  it('未知のキーは空にせずそのまま残す（差し込み漏れに気付けるように）', () => {
    // ★空で潰すと文章が静かに欠ける。
    expect(fillTemplate('{{a}}/{{b}}', { a: 'x' })).toBe('x/{{b}}');
    expect(unresolvedKeys('{{a}}/{{b}}', { a: 'x' })).toEqual(['b']);
  });

  it('本文はテキストのまま（HTML に変換しない）', () => {
    // ★HTML にすると受け手の環境で見え方が変わり、引用や転送でも崩れる。
    const d = buildDraft(['x@example.com'], { subject: 's', body: '1行目\n2行目 {{n}}' }, { n: 'A&B <x>' });
    expect(d.body).toBe('1行目\n2行目 A&B <x>');
  });

  it('宛先は ; 区切り、空は落とす', () => {
    const d = buildDraft(['a@x', '', 'b@x'], { subject: 's', body: 'b' }, {});
    expect(d.to).toBe('a@x; b@x');
  });

  it('CC / Reply-To は空なら付けない', () => {
    const d = buildDraft(['a@x'], { subject: 's', body: 'b', cc: '  ', replyTo: '' }, {});
    expect(d.cc).toBeUndefined();
    expect(d.replyTo).toBeUndefined();
  });

  it('件名にも差し込める（件名はエスケープしない）', () => {
    expect(buildDraft(['a@x'], { subject: '【{{c}}】通知', body: 'b' }, { c: 'A&B' }).subject).toBe('【A&B】通知');
  });
});
