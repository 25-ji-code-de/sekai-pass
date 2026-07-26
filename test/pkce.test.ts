/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PKCE 校验的测试。
 *
 * 这是授权码流程里防止 code 被拦截后冒用的唯一屏障 —— 如果 verifyPKCE
 * 在任何一种畸形输入下错误地返回 true，攻击者拿到 authorization code
 * 就能直接换 token。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyPKCE, validateCodeChallenge, validateCodeVerifier } from '../src/lib/pkce.ts';

/** RFC 7636 附录 B 的官方测试向量。 */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('verifyPKCE', () => {
  test('RFC 7636 附录 B 的官方测试向量', async () => {
    assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_CHALLENGE), true);
  });

  test('verifier 不匹配时拒绝', async () => {
    assert.equal(await verifyPKCE('wrong-verifier-' + 'x'.repeat(30), RFC_CHALLENGE), false);
  });

  test('challenge 被改动一个字符就拒绝', async () => {
    const tampered = RFC_CHALLENGE.slice(0, -1) + (RFC_CHALLENGE.endsWith('M') ? 'N' : 'M');
    assert.equal(await verifyPKCE(RFC_VERIFIER, tampered), false);
  });

  test('OAuth 2.1 只允许 S256 —— plain 方法必须被拒', async () => {
    // 如果这里返回 true，攻击者只要把 code_challenge_method 改成 plain
    // 并把 challenge 设为自己知道的明文，就绕过了整个 PKCE
    assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_VERIFIER, 'plain'), false);
    assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_CHALLENGE, 'plain'), false);
  });

  test('未知 method 一律拒绝', async () => {
    for (const method of ['S512', 'none', '', 'MD5', 's256']) {
      assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_CHALLENGE, method), false, method);
    }
  });

  test('method 缺省为 S256', async () => {
    assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_CHALLENGE, undefined), true);
  });

  test('空 verifier 不会意外通过', async () => {
    assert.equal(await verifyPKCE('', RFC_CHALLENGE), false);
    assert.equal(await verifyPKCE('', ''), false);
  });

  test('长度不同时立即拒绝（不泄漏更多信息）', async () => {
    assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_CHALLENGE + 'x'), false);
    assert.equal(await verifyPKCE(RFC_VERIFIER, RFC_CHALLENGE.slice(0, -1)), false);
  });

  test('challenge 前缀匹配但不完整时拒绝', async () => {
    // 防止实现里误用 startsWith 之类的比较
    const prefix = RFC_CHALLENGE.slice(0, 10);
    assert.equal(await verifyPKCE(RFC_VERIFIER, prefix), false);
  });
});

describe('validateCodeChallenge', () => {
  test('接受合法的 base64url challenge', () => {
    assert.equal(validateCodeChallenge(RFC_CHALLENGE, 'S256'), true);
    assert.equal(validateCodeChallenge(RFC_CHALLENGE, null), true, 'method 可省略');
  });

  test('拒绝空值', () => {
    assert.equal(validateCodeChallenge(null, 'S256'), false);
    assert.equal(validateCodeChallenge('', 'S256'), false);
  });

  test('长度必须在 43-128 之间', () => {
    assert.equal(validateCodeChallenge('a'.repeat(42), 'S256'), false);
    assert.equal(validateCodeChallenge('a'.repeat(43), 'S256'), true);
    assert.equal(validateCodeChallenge('a'.repeat(128), 'S256'), true);
    assert.equal(validateCodeChallenge('a'.repeat(129), 'S256'), false);
  });

  test('拒绝 base64url 字母表以外的字符', () => {
    const base = 'a'.repeat(42);
    for (const bad of ['+', '/', '=', ' ', '.', '~', '%', '<']) {
      assert.equal(validateCodeChallenge(base + bad, 'S256'), false, JSON.stringify(bad));
    }
    // - 与 _ 是 base64url 的合法字符
    assert.equal(validateCodeChallenge(base + '-', 'S256'), true);
    assert.equal(validateCodeChallenge(base + '_', 'S256'), true);
  });

  test('OAuth 2.1 拒绝 plain 与其它 method', () => {
    assert.equal(validateCodeChallenge(RFC_CHALLENGE, 'plain'), false);
    assert.equal(validateCodeChallenge(RFC_CHALLENGE, 'S512'), false);
    assert.equal(validateCodeChallenge(RFC_CHALLENGE, 's256'), false, '大小写敏感');
  });
});

describe('validateCodeVerifier', () => {
  test('接受合法 verifier', () => {
    assert.equal(validateCodeVerifier(RFC_VERIFIER), true);
  });

  test('拒绝空值', () => {
    assert.equal(validateCodeVerifier(null), false);
    assert.equal(validateCodeVerifier(''), false);
  });

  test('长度必须在 43-128 之间（RFC 7636 §4.1）', () => {
    assert.equal(validateCodeVerifier('a'.repeat(42)), false);
    assert.equal(validateCodeVerifier('a'.repeat(43)), true);
    assert.equal(validateCodeVerifier('a'.repeat(128)), true);
    assert.equal(validateCodeVerifier('a'.repeat(129)), false);
  });

  test('接受 RFC 7636 的 unreserved 字符集', () => {
    const base = 'a'.repeat(39);
    for (const ch of ['-', '.', '_', '~']) {
      assert.equal(validateCodeVerifier(base + ch.repeat(4)), true, ch);
    }
  });

  test('拒绝 unreserved 以外的字符', () => {
    const base = 'a'.repeat(42);
    for (const bad of ['+', '/', '=', ' ', '%', '&', '<', '\n']) {
      assert.equal(validateCodeVerifier(base + bad), false, JSON.stringify(bad));
    }
  });

  test('生态里客户端实际用的 128 位 hex verifier 合法', () => {
    // sekai-auth SDK 生成的是 64 随机字节 → 128 个 hex 字符
    assert.equal(validateCodeVerifier('a1b2c3d4'.repeat(16)), true);
  });
});

describe('端到端：SDK 生成的 verifier 能通过服务端校验', () => {
  test('用 WebCrypto 现算 challenge 后往返验证', async () => {
    // 模拟 sekai-auth SDK 的 randomHex(64)
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    const verifier = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    assert.equal(verifier.length, 128);
    assert.equal(validateCodeVerifier(verifier), true);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    let binary = '';
    for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
    const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    assert.equal(validateCodeChallenge(challenge, 'S256'), true);
    assert.equal(await verifyPKCE(verifier, challenge), true);
  });
});
