import { describe, it, expect } from 'vitest';
import { countSubscriptionIps } from '../src/qualys';

const wrap = (inner: string): string => `<IP_LIST_OUTPUT><RESPONSE><IP_SET>${inner}</IP_SET></RESPONSE></IP_LIST_OUTPUT>`;

describe('countSubscriptionIps（IPs in Subscription = 一意IP数）', () => {
  it('単一IPとレンジを合計（重複なし）', () => {
    expect(countSubscriptionIps(wrap('<IP>10.0.0.1</IP><IP>10.0.0.2</IP><IP_RANGE>10.0.0.10-10.0.0.12</IP_RANGE>'))).toBe(5); // 2 + 3
  });

  it('単一IPがレンジに含まれる重複は二重計上しない（Qualys UI と一致／+1 の原因）', () => {
    // 10.0.0.10 は単一IPとしても、レンジ 10.0.0.10-10.0.0.12 にも現れる → 一意は 3 件（単純合計だと 4）
    expect(countSubscriptionIps(wrap('<IP>10.0.0.10</IP><IP_RANGE>10.0.0.10-10.0.0.12</IP_RANGE>'))).toBe(3);
  });

  it('レンジ同士の重なりも除外', () => {
    // 10.0.0.1-10.0.0.5 と 10.0.0.4-10.0.0.8 → 和集合 10.0.0.1-10.0.0.8 = 8（単純合計だと 5+5=10）
    expect(countSubscriptionIps(wrap('<IP_RANGE>10.0.0.1-10.0.0.5</IP_RANGE><IP_RANGE>10.0.0.4-10.0.0.8</IP_RANGE>'))).toBe(8);
  });

  it('隣接（連続）するIP/レンジはそれぞれ別IPとして数える', () => {
    expect(countSubscriptionIps(wrap('<IP>10.0.0.4</IP><IP>10.0.0.5</IP>'))).toBe(2);
    expect(countSubscriptionIps(wrap('<IP_RANGE>10.0.0.1-10.0.0.5</IP_RANGE><IP_RANGE>10.0.0.6-10.0.0.10</IP_RANGE>'))).toBe(10);
  });

  it('属性付きタグ・空・不正値', () => {
    expect(countSubscriptionIps(wrap('<IP network_id="3">10.0.0.1</IP>'))).toBe(1);
    expect(countSubscriptionIps(wrap(''))).toBe(0);
    expect(countSubscriptionIps(wrap('<IP>not-an-ip</IP>'))).toBe(0);
  });
});
