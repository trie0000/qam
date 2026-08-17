import { describe, it, expect } from 'vitest';
import { fillTemplate, unresolvedKeys, buildDraft, escapeHtml, nl2br } from '../src/mail';

describe('メールテンプレートの差し込み', () => {
  it('{{キー}} を差し替える', () => {
    expect(fillTemplate('{{company}} 御中', { company: 'A事業会社' })).toBe('A事業会社 御中');
  });

  it('未知のキーは空にせずそのまま残す（差し込み漏れに気付けるように）', () => {
    // ★空で潰すと文章が静かに欠ける。
    expect(fillTemplate('{{a}}/{{b}}', { a: 'x' })).toBe('x/{{b}}');
    expect(unresolvedKeys('{{a}}/{{b}}', { a: 'x' })).toEqual(['b']);
  });

  it('値に含まれる HTML は無害化する（本文は HTML として送るため）', () => {
    expect(escapeHtml('A&B <script>')).toBe('A&amp;B &lt;script&gt;');
    const d = buildDraft(['x@example.com'], { subject: 's', body: '{{n}}' }, { n: '<b>悪意</b>' });
    expect(d.bodyHtml).toBe('&lt;b&gt;悪意&lt;/b&gt;');
  });

  it('リンクなど HTML のまま入れたい値は rawVars で渡す', () => {
    const d = buildDraft(['x@example.com'], { subject: 's', body: '{{link}}' }, {}, { link: '<a href="u">一覧</a>' });
    expect(d.bodyHtml).toContain('<a href="u">');
  });

  it('本文の改行は <br> にする（設定は複数行で入力する）', () => {
    expect(nl2br('1行目\n2行目')).toBe('1行目<br>\n2行目');
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
