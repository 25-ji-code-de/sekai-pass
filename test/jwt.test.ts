/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JWT 签名与校验的测试。
 *
 * 这里签的是 OIDC 的 ID Token —— 依赖方拿它来断言"用户是谁"。
 * 重点覆盖两类：往返正确性，以及**算法混淆**这类经典攻击面。
 *
 * 注意 verifyJWT 在未显式传 algorithm 时会从 JWT header 里读 alg
 * （src/lib/jwt.ts:152）。这是公认的反模式 —— 让攻击者控制的字段决定
 * 走哪条校验路径。下面的测试钉住它至少必须**安全降级**。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  signJWT,
  verifyJWT,
  decodeJWT,
  base64URLEncode,
  base64URLDecode,
} from '../src/lib/jwt.ts';

let esPrivate: JsonWebKey;
let esPublic: JsonWebKey;
let otherPublic: JsonWebKey;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  esPrivate = await crypto.subtle.exportKey('jwk', pair.privateKey);
  esPublic = await crypto.subtle.exportKey('jwk', pair.publicKey);

  const other = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  otherPublic = await crypto.subtle.exportKey('jwk', other.publicKey);
});

const claims = () => ({
  iss: 'https://id.nightcord.de5.net',
  sub: 'user-001',
  aud: 'hub_client',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
});

describe('base64URL 编解码', () => {
  test('往返还原', () => {
    for (const bytes of [[], [0], [255], [1, 2, 3, 4, 5], [251, 255, 190]]) {
      const input = new Uint8Array(bytes);
      const decoded = new Uint8Array(base64URLDecode(base64URLEncode(input)));
      assert.deepEqual([...decoded], bytes);
    }
  });

  test('输出无 padding 且不含 + /', () => {
    const encoded = base64URLEncode(new Uint8Array([251, 255, 190]));
    assert.ok(!encoded.includes('='));
    assert.ok(!encoded.includes('+'));
    assert.ok(!encoded.includes('/'));
  });

  test('解码时自行补 padding', () => {
    // 长度 % 4 分别为 2 和 3 的情况
    assert.doesNotThrow(() => base64URLDecode(base64URLEncode(new Uint8Array([1]))));
    assert.doesNotThrow(() => base64URLDecode(base64URLEncode(new Uint8Array([1, 2]))));
  });
});

describe('ES256 签名与校验', () => {
  test('往返：自己签的自己能验', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    assert.equal(await verifyJWT(token, esPublic), true);
  });

  test('token 结构是三段', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    assert.equal(token.split('.').length, 3);
  });

  test('header 带 alg / typ / kid', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-abc');
    const decoded = decodeJWT(token);
    assert.equal(decoded?.header.alg, 'ES256');
    assert.equal(decoded?.header.kid, 'kid-abc');
    assert.equal(decoded?.header.typ, 'JWT');
  });

  test('payload 原样保留', async () => {
    const c = claims();
    const token = await signJWT(c, esPrivate, 'kid-1');
    const decoded = decodeJWT(token);
    assert.equal(decoded?.payload.sub, c.sub);
    assert.equal(decoded?.payload.iss, c.iss);
    assert.equal(decoded?.payload.aud, c.aud);
  });

  test('用别的公钥验签失败', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    assert.equal(await verifyJWT(token, otherPublic), false);
  });
});

describe('篡改检测', () => {
  test('改 payload 后验签失败', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    const [h, , s] = token.split('.');
    const evil = base64URLEncode(
      new TextEncoder().encode(JSON.stringify({ ...claims(), sub: 'admin' })),
    );
    assert.equal(await verifyJWT(`${h}.${evil}.${s}`, esPublic), false);
  });

  test('改 header 后验签失败', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    const [, p, s] = token.split('.');
    const evil = base64URLEncode(
      new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'other' })),
    );
    assert.equal(await verifyJWT(`${evil}.${p}.${s}`, esPublic), false);
  });

  test('改签名后验签失败', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    const [h, p, s] = token.split('.');
    const flipped = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    assert.equal(await verifyJWT(`${h}.${p}.${flipped}`, esPublic), false);
  });

  test('空签名被拒', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    const [h, p] = token.split('.');
    assert.equal(await verifyJWT(`${h}.${p}.`, esPublic), false);
  });
});

describe('算法混淆（攻击面）', () => {
  test('alg: none 必须被拒', async () => {
    const header = base64URLEncode(
      new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    );
    const payload = base64URLEncode(
      new TextEncoder().encode(JSON.stringify({ ...claims(), sub: 'admin' })),
    );
    assert.equal(await verifyJWT(`${header}.${payload}.`, esPublic), false);
    assert.equal(await verifyJWT(`${header}.${payload}.AAAA`, esPublic), false);
  });

  test('把 ES256 的 token 头改成 RS256 后必须被拒', async () => {
    // verifyJWT 会信任 header 里的 alg；这里确认它至少安全降级
    // （用 EC 公钥按 RSA 导入会失败 → catch → false）
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    const [, p, s] = token.split('.');
    const rsHeader = base64URLEncode(
      new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' })),
    );
    assert.equal(await verifyJWT(`${rsHeader}.${p}.${s}`, esPublic), false);
  });

  test('HS256（对称）不在支持列表里，必须被拒', async () => {
    // 经典攻击：把公钥当 HMAC 密钥用。本实现不支持 HS256，应直接拒绝
    const header = base64URLEncode(
      new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    );
    const payload = base64URLEncode(new TextEncoder().encode(JSON.stringify(claims())));
    assert.equal(await verifyJWT(`${header}.${payload}.AAAA`, esPublic), false);
  });

  test('显式传入的 algorithm 优先于 header', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    assert.equal(await verifyJWT(token, esPublic, 'ES256'), true);
    assert.equal(await verifyJWT(token, esPublic, 'RS256'), false);
  });
});

describe('畸形输入', () => {
  test('段数不对一律返回 false', async () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '..', '....']) {
      assert.equal(await verifyJWT(bad, esPublic), false, JSON.stringify(bad));
    }
  });

  test('非 base64 内容返回 false 而不抛', async () => {
    assert.equal(await verifyJWT('!!!.???.###', esPublic), false);
  });

  test('decodeJWT 对畸形输入返回 null', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'notbase64.notbase64.x']) {
      assert.equal(decodeJWT(bad), null, JSON.stringify(bad));
    }
  });

  test('decodeJWT 不校验签名 —— 只用于观察', async () => {
    const token = await signJWT(claims(), esPrivate, 'kid-1');
    const [h, p] = token.split('.');
    const decoded = decodeJWT(`${h}.${p}.GARBAGE`);
    assert.equal(decoded?.payload.sub, 'user-001', 'decodeJWT 明确不做校验');
    // 但 verifyJWT 必须拒绝它
    assert.equal(await verifyJWT(`${h}.${p}.GARBAGE`, esPublic), false);
  });
});
