/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 客户端密码解包与请求参数校验的测试。
 *
 * 注意 decryptPassword 名字里的 "decrypt" 有点误导 —— 它做的是
 * base64 解包加时间戳校验，不是加密。真正的机密性来自 HTTPS。
 * 这里测的是它作为**重放窗口**的行为：过期的包必须被拒。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decryptPassword, validateRequest } from '../src/lib/decrypt.ts';

/** 按客户端的打包格式构造：base64(password|salt|timestamp)。 */
function pack(password: string, salt: string, timestamp: number | string): string {
  const combined = `${password}|${salt}|${timestamp}`;
  const bytes = new TextEncoder().encode(combined);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const FIVE_MIN = 5 * 60 * 1000;

describe('decryptPassword', () => {
  test('取出密码部分', () => {
    assert.equal(decryptPassword(pack('s3cr3t', 'salt', Date.now())), 's3cr3t');
  });

  test('非 ASCII 密码能正确还原（UTF-8 往返）', () => {
    const pw = '密码🔑パスワード';
    assert.equal(decryptPassword(pack(pw, 'salt', Date.now())), pw);
  });

  test('密码里含分隔符时只取第一段 —— 这是已知的格式限制', () => {
    // combined.split('|') 要求恰好三段，所以密码里带 | 会导致解包失败
    assert.throws(() => decryptPassword(pack('a|b', 'salt', Date.now())), /Failed to decrypt/);
  });

  test('超过 5 分钟的包被拒（重放窗口）', () => {
    assert.throws(
      () => decryptPassword(pack('s3cr3t', 'salt', Date.now() - FIVE_MIN - 1000)),
      /Failed to decrypt/,
    );
  });

  test('未来 5 分钟以上的包也被拒（时钟偏移容忍是双向的）', () => {
    assert.throws(
      () => decryptPassword(pack('s3cr3t', 'salt', Date.now() + FIVE_MIN + 1000)),
      /Failed to decrypt/,
    );
  });

  test('窗口边界内的包通过', () => {
    assert.equal(decryptPassword(pack('ok', 'salt', Date.now() - FIVE_MIN + 5000)), 'ok');
    assert.equal(decryptPassword(pack('ok', 'salt', Date.now() + FIVE_MIN - 5000)), 'ok');
  });

  test('段数不对时被拒', () => {
    assert.throws(() => decryptPassword(pack('a', 'b', '') + ''), /Failed to decrypt/);
    for (const combined of ['onlyone', 'a|b', 'a|b|c|d']) {
      const b64 = btoa(combined);
      assert.throws(() => decryptPassword(b64), /Failed to decrypt/, combined);
    }
  });

  test('时间戳不是数字时被拒', () => {
    assert.throws(() => decryptPassword(pack('s', 'salt', 'not-a-number')), /Failed to decrypt/);
  });

  test('非法 base64 时抛出统一错误而不泄漏内部细节', () => {
    for (const bad of ['', '!!!', 'a', '@@@@']) {
      assert.throws(
        () => decryptPassword(bad),
        (err: Error) => err.message === 'Failed to decrypt password',
        JSON.stringify(bad),
      );
    }
  });

  test('错误信息统一 —— 不区分"格式错"与"过期"', () => {
    // 对外只给一句话，避免用探测错误信息来区分失败原因
    const expired = pack('s', 'salt', Date.now() - FIVE_MIN - 1);
    const malformed = btoa('nope');
    let m1 = '';
    let m2 = '';
    try { decryptPassword(expired); } catch (e) { m1 = (e as Error).message; }
    try { decryptPassword(malformed); } catch (e) { m2 = (e as Error).message; }
    assert.equal(m1, m2);
  });
});

describe('validateRequest', () => {
  const nonce = 'a'.repeat(32);

  test('三个参数齐全且合法时通过', () => {
    assert.equal(validateRequest(nonce, 'fp', String(Date.now())), true);
  });

  test('任一参数缺失即拒绝', () => {
    assert.equal(validateRequest(null, 'fp', String(Date.now())), false);
    assert.equal(validateRequest(nonce, null, String(Date.now())), false);
    assert.equal(validateRequest(nonce, 'fp', null), false);
    assert.equal(validateRequest('', 'fp', String(Date.now())), false);
    assert.equal(validateRequest(nonce, '', String(Date.now())), false);
  });

  test('nonce 必须是 32 个小写十六进制字符', () => {
    const ts = String(Date.now());
    assert.equal(validateRequest('0123456789abcdef0123456789abcdef', 'fp', ts), true);
    assert.equal(validateRequest('A'.repeat(32), 'fp', ts), false, '大写不接受');
    assert.equal(validateRequest('a'.repeat(31), 'fp', ts), false, '太短');
    assert.equal(validateRequest('a'.repeat(33), 'fp', ts), false, '太长');
    assert.equal(validateRequest('g'.repeat(32), 'fp', ts), false, '非十六进制');
    assert.equal(validateRequest('a'.repeat(31) + '-', 'fp', ts), false);
  });

  test('时间戳超出 ±5 分钟即拒绝', () => {
    assert.equal(validateRequest(nonce, 'fp', String(Date.now() - FIVE_MIN - 1000)), false);
    assert.equal(validateRequest(nonce, 'fp', String(Date.now() + FIVE_MIN + 1000)), false);
  });

  test('时间戳不是数字时拒绝', () => {
    assert.equal(validateRequest(nonce, 'fp', 'abc'), false);
    assert.equal(validateRequest(nonce, 'fp', ''), false);
  });
});
