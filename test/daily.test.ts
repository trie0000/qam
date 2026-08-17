import { describe, it, expect } from 'vitest';
import {
  classifyTicketChange, classifyTickets, isOpenState, reportTargets, reportPath, reportTitle,
} from '../src/daily';
import type { RasTicket } from '../src/ras';

const t = (number: string, state: string, ip = '10.0.0.1', hostId = 'h1'): RasTicket =>
  ({ number, state, hostId, ip, fqdn: 'a.example', settenId: 'R100', businessCompany: 'A社', created: '2026-08-01T00:00:00Z' });

describe('チケットの状態', () => {
  it('OPEN だけが「開いている」。RESOLVED/CLOSED/IGNORED は閉じている扱い', () => {
    expect(isOpenState('OPEN')).toBe(true);
    expect(isOpenState(' open ')).toBe(true);
    for (const s of ['RESOLVED', 'CLOSED', 'IGNORED', '']) expect(isOpenState(s)).toBe(false);
  });
});

describe('変化の判定', () => {
  it('前回に無く今回 OPEN なら新規', () => {
    expect(classifyTicketChange(undefined, t('1', 'OPEN'), false)).toBe('new');
  });

  it('初回の取込では全件を新規にしない', () => {
    // ★前回が空なだけで全部「新規」にすると、初回に一覧が新規で埋まって意味を失う。
    expect(classifyTicketChange(undefined, t('1', 'OPEN'), true)).toBe('');
  });

  it('OPEN → 閉じた ならクローズ', () => {
    for (const s of ['CLOSED', 'RESOLVED', 'IGNORED']) {
      expect(classifyTicketChange(t('1', 'OPEN'), t('1', s), false)).toBe('closed');
    }
  });

  it('閉じていた → OPEN なら再検知', () => {
    expect(classifyTicketChange(t('1', 'CLOSED'), t('1', 'OPEN'), false)).toBe('reopened');
  });

  it('状態が変わらなければラベルは付けない', () => {
    expect(classifyTicketChange(t('1', 'OPEN'), t('1', 'OPEN'), false)).toBe('');
    expect(classifyTicketChange(t('1', 'CLOSED'), t('1', 'CLOSED'), false)).toBe('');
  });

  it('前回に無く今回も閉じているものはラベル無し（過去分の取り込み）', () => {
    expect(classifyTicketChange(undefined, t('1', 'CLOSED'), false)).toBe('');
  });

  it('一覧ぶんをまとめて判定できる', () => {
    const prev = [t('1', 'OPEN'), t('2', 'CLOSED')];
    const next = [t('1', 'CLOSED'), t('2', 'OPEN'), t('3', 'OPEN')];
    expect(classifyTickets(prev, next).map((r) => `${r.ticket.number}:${r.change}`))
      .toEqual(['1:closed', '2:reopened', '3:new']);
  });
});

describe('レポート対象の抽出', () => {
  it('新規と再検知のホストだけを、ホスト単位でまとめる', () => {
    const results = classifyTickets(
      [t('2', 'CLOSED', '10.0.0.2', 'h2')],
      [t('1', 'OPEN', '10.0.0.1', 'h1'), t('9', 'OPEN', '10.0.0.1', 'h1'), t('2', 'OPEN', '10.0.0.2', 'h2'), t('3', 'CLOSED', '10.0.0.3', 'h3')],
    );
    const targets = reportTargets(results);
    expect(targets.map((x) => x.ip)).toEqual(['10.0.0.1', '10.0.0.2']); // クローズのホストは対象外
    expect(targets[0].tickets).toEqual(['1', '9']); // 同じホストの複数チケットは1件にまとめる
  });

  it('IP が無いものは落とす（Qualys に対象を渡せない）', () => {
    const results = classifyTickets([], [{ ...t('1', 'OPEN'), ip: '' }]);
    expect(reportTargets(results)).toEqual([]);
  });
});

describe('レポートの保存先と名前', () => {
  it('日付フォルダの下に IP と言語で分けて置く', () => {
    expect(reportPath('2026-08-17T10-30-00', '10.0.0.1', 'ja')).toBe('reports/2026-08-17/10.0.0.1-ja-2026-08-17T10-30-00.pdf');
  });

  it('パスに使えない文字は落とす（IP以外が来ても壊れない）', () => {
    expect(reportPath('2026-08-17T10-30-00', 'a/b:c', 'en')).toContain('a_b_c-en-');
  });

  it('タイトルは 128 文字に収める（Qualys の上限）', () => {
    expect(reportTitle('10.0.0.1', 'x'.repeat(200), '2026-08-17T10-30-00').length).toBe(128);
  });
});
