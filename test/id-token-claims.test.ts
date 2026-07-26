/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ID Token claim 构造与 OIDC scope 映射的测试。
 *
 * ID Token 是依赖方用来断言「用户是谁」的凭据，里面放了什么就等于披露了什么。
 *
 * 这里有一处**三方不一致**（见 issue，本测试只钉住现状、不改行为）：
 * 对 admin scope，三个描述「能看到什么」的函数各说各话 ——
 *   buildIDTokenClaims  → 给全部 profile + email 字段（用 hasScopes，admin 一票通过）
 *   filterUserData      → 空对象（用 includes，admin 不含 profile）
 *   getClaimsForScope   → 只有 sub
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildIDTokenClaims } from '../src/lib/id-token.ts';
import { isOIDCRequest, getClaimsForScope, validateOIDCScope } from '../src/lib/oidc-scope.ts';
import { filterUserData } from '../src/lib/scope.ts';

const user = {
  id: 'u1',
  username: 'nako',
  display_name: 'なこ',
  email: 'nako@example.com',
  avatar_url: 'https://cdn.example/a.png',
  bio: '25時、コードで。',
  password_hash: 'PBKDF2$deadbeef',
};

const ISSUER = 'https://id.nightcord.de5.net';
const CLIENT = 'hub_client';

/** 除去所有协议字段，只留用户数据字段。 */
function userClaims(claims: Record<string, unknown>): string[] {
  const protocolFields = ['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'acr', 'amr', 'nonce'];
  return Object.keys(claims).filter((k) => !protocolFields.includes(k)).sort();
}

const build = (scope: string, nonce: string | null = null) =>
  buildIDTokenClaims(user, CLIENT, ISSUER, nonce, Date.now(), scope);

describe('协议字段', () => {
  test('iss / sub / aud 来自参数', () => {
    const c = build('openid profile');
    assert.equal(c.iss, ISSUER);
    assert.equal(c.sub, user.id);
    assert.equal(c.aud, CLIENT);
  });

  test('有效期 1 小时，且 iat 是秒级', () => {
    const now = Math.floor(Date.now() / 1000);
    const c = build('openid');
    assert.ok(c.iat >= now - 1 && c.iat <= now + 1);
    assert.equal(c.exp - c.iat, 3600);
  });

  test('auth_time 从毫秒转成秒', () => {
    const authTime = 1_700_000_000_000;
    const c = buildIDTokenClaims(user, CLIENT, ISSUER, null, authTime, 'openid');
    assert.equal(c.auth_time, 1_700_000_000);
  });

  test('nonce 给了才带 —— 防重放要靠它', () => {
    assert.equal(build('openid').nonce, undefined);
    assert.equal(build('openid', 'n-abc').nonce, 'n-abc');
  });

  test('带上认证上下文 acr / amr', () => {
    const c = build('openid');
    assert.equal(typeof c.acr, 'string');
    assert.deepEqual(c.amr, ['pwd']);
  });
});

describe('按 scope 披露用户字段', () => {
  test('profile 给 name / preferred_username / picture / bio', () => {
    assert.deepEqual(userClaims(build('openid profile')), [
      'bio',
      'name',
      'picture',
      'preferred_username',
    ]);
  });

  test('email 给 email 与 email_verified', () => {
    assert.deepEqual(userClaims(build('openid email')), ['email', 'email_verified']);
  });

  test('没有 email scope 就不含 email', () => {
    for (const scope of ['openid', 'openid profile', 'applications']) {
      assert.ok(!('email' in build(scope)), scope);
    }
  });

  test('绝不外泄 password_hash', () => {
    for (const scope of ['openid profile email', 'admin', '']) {
      assert.ok(!('password_hash' in build(scope)), scope);
    }
  });

  test('可选字段缺失时不出现', () => {
    const minimal = { id: 'u2', username: 'x', display_name: 'X' };
    const c = buildIDTokenClaims(minimal, CLIENT, ISSUER, null, Date.now(), 'openid profile');
    assert.ok(!('picture' in c));
    assert.ok(!('bio' in c));
    assert.equal(c.preferred_username, 'x');
  });
});

describe('admin scope 的三方不一致（钉住现状，见 issue）', () => {
  const ADMIN = 'admin';

  test('ID Token 给全部 profile + email 字段', () => {
    // buildIDTokenClaims 用 hasScopes，而 hasScopes 里 admin 一票通过
    assert.deepEqual(userClaims(build(ADMIN)), [
      'bio',
      'email',
      'email_verified',
      'name',
      'picture',
      'preferred_username',
    ]);
  });

  test('userinfo 端点却什么都不给', () => {
    // filterUserData 用 includes，admin 不含 profile/email
    assert.deepEqual(filterUserData(user, ADMIN), {});
  });

  test('getClaimsForScope 声称只有 sub', () => {
    assert.deepEqual(getClaimsForScope(ADMIN), ['sub']);
  });

  test('三者对同一个 scope 的答案互相矛盾', () => {
    const inIdToken = userClaims(build(ADMIN)).length;
    const inUserinfo = Object.keys(filterUserData(user, ADMIN)).length;
    const declared = getClaimsForScope(ADMIN).filter((c) => c !== 'sub').length;

    assert.ok(inIdToken > 0, 'ID Token 给了字段');
    assert.equal(inUserinfo, 0, 'userinfo 一个不给');
    assert.equal(declared, 0, '声明里也说没有');
    // 这条断言就是矛盾本身。修复方向确定后应当改成三者一致。
    assert.notEqual(inIdToken, declared, '现状：ID Token 比声明的多');
  });
});

describe('isOIDCRequest', () => {
  test('含 openid 才算 OIDC 请求', () => {
    assert.equal(isOIDCRequest('openid profile'), true);
    assert.equal(isOIDCRequest('profile'), false);
    assert.equal(isOIDCRequest(null), false);
    assert.equal(isOIDCRequest(''), false);
  });

  test('要整词匹配，不能被子串蒙混', () => {
    assert.equal(isOIDCRequest('openidx'), false);
    assert.equal(isOIDCRequest('notopenid'), false);
  });
});

describe('getClaimsForScope', () => {
  test('sub 永远在', () => {
    for (const scope of ['', 'profile', 'email', 'openid', 'bogus']) {
      assert.ok(getClaimsForScope(scope).includes('sub'), scope);
    }
  });

  test('openid 追加 auth_time', () => {
    assert.ok(getClaimsForScope('openid').includes('auth_time'));
    assert.ok(!getClaimsForScope('profile').includes('auth_time'));
  });

  test('结果去重', () => {
    const claims = getClaimsForScope('openid profile profile email');
    assert.equal(claims.length, new Set(claims).size);
  });

  test('未知 scope 不追加任何 claim', () => {
    assert.deepEqual(getClaimsForScope('bogus'), ['sub']);
  });
});

describe('validateOIDCScope', () => {
  test('接受合法组合', () => {
    assert.equal(validateOIDCScope('openid profile email').valid, true);
  });

  test('空值有明确的处理结果', () => {
    // 不断言具体取值，只要求不抛异常并给出布尔
    assert.equal(typeof validateOIDCScope(null).valid, 'boolean');
    assert.equal(typeof validateOIDCScope(undefined).valid, 'boolean');
  });
});
