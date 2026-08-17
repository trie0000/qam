import { describe, it, expect } from 'vitest';
import { countSubscriptionIps, qualysActionError, responseSnippet } from '../src/qualys';

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

import { toHalfWidth, splitJpName, roleForScanType, buildUserAddFields } from '../src/qualys';

describe('ユーザ登録の入力整形', () => {
  it('toHalfWidth: 全角英数記号・全角スペースを半角化、漢字は不変', () => {
    expect(toHalfWidth('ＴＡＲＯ')).toBe('TARO');
    expect(toHalfWidth('ａｂ１２＠')).toBe('ab12@');
    expect(toHalfWidth('山田　太郎')).toBe('山田 太郎'); // 全角スペース→半角
    expect(toHalfWidth('山田')).toBe('山田');
  });

  it('splitJpName: 全角スペースで姓/名に分割（英字は半角化）', () => {
    expect(splitJpName('山田　太郎')).toEqual({ lastName: '山田', firstName: '太郎' });
    expect(splitJpName('ＹＡＭＡＤＡ　ＴＡＲＯ')).toEqual({ lastName: 'YAMADA', firstName: 'TARO' });
    expect(splitJpName('山田 太郎')).toEqual({ lastName: '山田', firstName: '太郎' }); // 半角区切りも可
  });

  it('roleForScanType: 動的は Reader 固定、静的は選択値', () => {
    expect(roleForScanType('dynamic', 'scanner')).toBe('reader');
    expect(roleForScanType('dynamic', 'reader')).toBe('reader');
    expect(roleForScanType('static', 'scanner')).toBe('scanner');
    expect(roleForScanType('static', 'reader')).toBe('reader');
  });

  it('buildUserAddFields: 必須は"-"・送信不要は除外・動的はreader・asset_groups結合', () => {
    const f = buildUserAddFields({
      fullName: '山田　太郎', email: ' t@example.com ', scanType: 'dynamic', role: 'scanner',
      assetGroups: ['AB123 拠点', 'CD456 拠点2'], businessUnit: 'Unassigned', country: 'Japan',
    });
    expect(f.user_role).toBe('reader');        // 動的→reader固定
    expect(f.first_name).toBe('太郎');
    expect(f.last_name).toBe('山田');
    expect(f.email).toBe('t@example.com');      // trim
    expect(f.title).toBe('-'); expect(f.phone).toBe('-'); expect(f.address1).toBe('-'); expect(f.city).toBe('-');
    expect(f.country).toBe('Japan');
    expect(f.business_unit).toBe('Unassigned');
    expect(f.send_email).toBe('0');
    expect(f.asset_groups).toBe('AB123 拠点,CD456 拠点2');
  });

  it('buildUserAddFields: asset_groups 空なら項目自体を出さない', () => {
    const f = buildUserAddFields({ fullName: '佐藤　花子', email: 'h@example.com', scanType: 'static', role: 'scanner', assetGroups: [], businessUnit: 'BU1', country: 'Japan' });
    expect(f.user_role).toBe('scanner');
    expect('asset_groups' in f).toBe(false);
  });
});

import { analyzeSubscriptionIps } from '../src/qualys';
const wrapIp = (inner: string): string => `<IP_LIST_OUTPUT><RESPONSE><IP_SET>${inner}</IP_SET></RESPONSE></IP_LIST_OUTPUT>`;

describe('analyzeSubscriptionIps（IP重複チェック）', () => {
  it('重複なし: unique==rawSum, pairs空', () => {
    const r = analyzeSubscriptionIps(wrapIp('<IP>10.0.0.1</IP><IP_RANGE>10.0.0.10-10.0.0.12</IP_RANGE>'));
    expect(r.unique).toBe(4); expect(r.rawSum).toBe(4); expect(r.duplicates).toBe(0); expect(r.pairs).toEqual([]);
  });
  it('単体×レンジの重複を検出（+1のズレ要因）', () => {
    const r = analyzeSubscriptionIps(wrapIp('<IP>10.0.0.10</IP><IP_RANGE>10.0.0.10-10.0.0.12</IP_RANGE>'));
    expect(r.unique).toBe(3); expect(r.rawSum).toBe(4); expect(r.duplicates).toBe(1);
    expect(r.pairs.length).toBe(1); expect(r.pairs[0].overlap).toBe(1);
    expect(r.pairs[0].a).toBe('10.0.0.10'); expect(r.pairs[0].b).toBe('10.0.0.10-10.0.0.12');
  });
  it('レンジ×レンジの重複', () => {
    const r = analyzeSubscriptionIps(wrapIp('<IP_RANGE>10.0.0.1-10.0.0.5</IP_RANGE><IP_RANGE>10.0.0.4-10.0.0.8</IP_RANGE>'));
    expect(r.unique).toBe(8); expect(r.rawSum).toBe(10); expect(r.duplicates).toBe(2);
    expect(r.pairs[0].overlap).toBe(2); // .4,.5
  });
  it('完全重複の単体IP', () => {
    const r = analyzeSubscriptionIps(wrapIp('<IP>10.0.0.7</IP><IP>10.0.0.7</IP>'));
    expect(r.duplicates).toBe(1); expect(r.pairs.length).toBe(1);
  });
});

import { extractIpTokens } from '../src/qualys';
describe('extractIpTokens（単体/レンジ抽出）', () => {
  it('単体IPとレンジを分けて抽出・不正値は除外', () => {
    const t = extractIpTokens(wrapIp('<IP>10.0.0.1</IP><IP network_id="3">10.0.0.2</IP><IP_RANGE>10.0.0.10-10.0.0.12</IP_RANGE><IP>bad</IP>'));
    expect(t.singles).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(t.ranges).toEqual(['10.0.0.10-10.0.0.12']);
  });
});

describe('Qualys のエラー応答の読み取り', () => {
  it('★<RETURN status="FAILED"> も拾う（<CODE> を持たない形）', () => {
    // これを拾えず「レポートIDを取得できませんでした」だけが並んで原因を追えなかった。
    const xml = '<?xml version="1.0"?><!DOCTYPE GENERIC_RETURN SYSTEM "x.dtd"><GENERIC_RETURN>'
      + '<API name="index.php"><RETURN status="FAILED" number="1960">'
      + '<MESSAGE>You have reached the maximum number of allowed concurrent running reports.</MESSAGE>'
      + '</RETURN></API></GENERIC_RETURN>';
    expect(qualysActionError(xml)).toBe('You have reached the maximum number of allowed concurrent running reports.（コード 1960）');
  });

  it('MESSAGE が無くても本文を出す', () => {
    expect(qualysActionError('<GENERIC_RETURN><RETURN status="FAILED" number="999">Internal error</RETURN></GENERIC_RETURN>'))
      .toBe('Internal error（コード 999）');
  });

  it('成功応答をエラーにしない', () => {
    const ok = '<SIMPLE_RETURN><RESPONSE><TEXT>New report launched</TEXT>'
      + '<ITEM_LIST><ITEM><KEY>ID</KEY><VALUE>12345</VALUE></ITEM></ITEM_LIST></RESPONSE></SIMPLE_RETURN>';
    expect(qualysActionError(ok)).toBe('');
  });

  it('<CODE> を持つ従来の形も引き続き読む', () => {
    expect(qualysActionError('<SIMPLE_RETURN><RESPONSE><CODE>1905</CODE><TEXT>Bad template</TEXT></RESPONSE></SIMPLE_RETURN>'))
      .toBe('Bad template（コード 1905）');
  });

  it('中身を見せるための短縮（空なら空と分かるように）', () => {
    expect(responseSnippet('')).toBe('(応答が空でした)');
    expect(responseSnippet('<?xml version="1.0"?><A>  x   y </A>')).toBe('<A> x y </A>');
    expect(responseSnippet('y'.repeat(400)).endsWith(' …')).toBe(true);
  });
});
