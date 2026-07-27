/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth scope 逻辑的测试。
 *
 * filterUserData 决定 userinfo 端点按 scope 吐哪些字段 —— 这是**权限边界**。
 * 写错就是越权泄露：比如把 email 在没有 email scope 时也返回，
 * 或者不小心把整个 user 行（含 password_hash）透出去。
 *
 * hasScopes 决定端点准入。ADMIN 在这里是「一票通过」，语义要钉死。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPES,
  SCOPE_DESCRIPTIONS,
  parseScopes,
  formatScopes,
  hasScopes,
  validateScopeParameter,
  filterUserData,
} from '../src/lib/scope.ts';

/** 一个「完整的」数据库用户行 —— 故意带上绝不能外泄的字段。 */
const dbUser = {
  id: 'u1',
  username: 'nako',
  display_name: 'なこ',
  avatar_url: 'https://cdn.example/a.png',
  bio: '25時、コードで。',
  email: 'nako@example.com',
  password_hash: 'PBKDF2$deadbeef',
  session_secret: 'super-secret',
  created_at: 1700000000,
};

describe('SCOPES 常量', () => {
  test('五个 scope 都有描述', () => {
    for (const scope of Object.values(SCOPES)) {
      assert.ok(SCOPE_DESCRIPTIONS[scope], `${scope} 缺少描述`);
    }
  });

  test('描述里没有多余的 key', () => {
    assert.deepEqual(
      Object.keys(SCOPE_DESCRIPTIONS).sort(),
      Object.values(SCOPES).sort(),
    );
  });
});

describe('parseScopes', () => {
  test('空值回落到默认的 profile', () => {
    assert.deepEqual(parseScopes(null), [SCOPES.PROFILE]);
    assert.deepEqual(parseScopes(undefined), [SCOPES.PROFILE]);
    assert.deepEqual(parseScopes(''), [SCOPES.PROFILE]);
  });

  test('拆分并保留已知 scope', () => {
    assert.deepEqual(parseScopes('openid profile email'), [
      SCOPES.OPENID,
      SCOPES.PROFILE,
      SCOPES.EMAIL,
    ]);
  });

  test('未知 scope 被丢弃而不是报错', () => {
    assert.deepEqual(parseScopes('profile bogus'), [SCOPES.PROFILE]);
    assert.deepEqual(parseScopes('bogus'), [], '全是未知时返回空数组，**不**回落到默认');
  });

  test('大小写敏感 —— Profile 不等于 profile', () => {
    assert.deepEqual(parseScopes('Profile'), []);
  });

  test('多余空白不影响拆分', () => {
    assert.deepEqual(parseScopes('  profile   email  '), [SCOPES.PROFILE, SCOPES.EMAIL]);
  });

  test('纯空白与空串行为不同（已知的不一致，这里钉住现状）', () => {
    // '' 走 falsy 分支 → 默认 profile；'   ' 是真值 → 拆分后全被过滤 → []
    // 空白那条更严格，不构成越权，但值得记录
    assert.deepEqual(parseScopes(''), [SCOPES.PROFILE]);
    assert.deepEqual(parseScopes('   '), []);
  });
});

describe('formatScopes', () => {
  test('空格连接', () => {
    assert.equal(formatScopes([SCOPES.OPENID, SCOPES.PROFILE]), 'openid profile');
    assert.equal(formatScopes([]), '');
  });

  test('与 parseScopes 往返', () => {
    const scopes = [SCOPES.OPENID, SCOPES.PROFILE, SCOPES.EMAIL];
    assert.deepEqual(parseScopes(formatScopes(scopes)), scopes);
  });
});

describe('hasScopes —— 端点准入', () => {
  test('拥有所需 scope 时通过', () => {
    assert.equal(hasScopes('profile email', [SCOPES.PROFILE]), true);
    assert.equal(hasScopes('profile email', [SCOPES.PROFILE, SCOPES.EMAIL]), true);
  });

  test('缺少任一所需 scope 即拒绝', () => {
    assert.equal(hasScopes('profile', [SCOPES.EMAIL]), false);
    assert.equal(hasScopes('profile', [SCOPES.PROFILE, SCOPES.EMAIL]), false);
  });

  test('admin 一票通过 —— 这是有意的，钉住它', () => {
    for (const required of [
      [SCOPES.EMAIL],
      [SCOPES.APPLICATIONS],
      [SCOPES.PROFILE, SCOPES.EMAIL, SCOPES.APPLICATIONS],
    ]) {
      assert.equal(hasScopes('admin', required), true, formatScopes(required));
    }
  });

  test('未知 scope 不能顶替所需 scope', () => {
    assert.equal(hasScopes('bogus', [SCOPES.PROFILE]), false);
    assert.equal(hasScopes('Admin', [SCOPES.EMAIL]), false, '大小写敏感');
  });

  test('不要求任何 scope 时恒通过', () => {
    assert.equal(hasScopes('', []), true);
  });

  test('空 granted 回落到 profile，所以 profile 会通过', () => {
    // parseScopes('') → [profile]，这是既有的默认行为
    assert.equal(hasScopes('', [SCOPES.PROFILE]), true);
    assert.equal(hasScopes('', [SCOPES.EMAIL]), false);
  });
});

describe('validateScopeParameter', () => {
  test('空值合法，回落到 profile', () => {
    const r = validateScopeParameter(null);
    assert.equal(r.valid, true);
    assert.deepEqual(r.scopes, [SCOPES.PROFILE]);
  });

  test('全部合法时通过', () => {
    const r = validateScopeParameter('openid profile email');
    assert.equal(r.valid, true);
    assert.deepEqual(r.scopes, [SCOPES.OPENID, SCOPES.PROFILE, SCOPES.EMAIL]);
  });

  test('含未知 scope 时拒绝，并在错误里点名', () => {
    const r = validateScopeParameter('profile bogus evil');
    assert.equal(r.valid, false);
    assert.match(r.error, /bogus/);
    assert.match(r.error, /evil/);
    assert.deepEqual(r.scopes, []);
  });

  test('这里比 parseScopes 严格 —— 后者只是丢弃未知项', () => {
    assert.deepEqual(parseScopes('profile bogus'), [SCOPES.PROFILE], 'parseScopes 静默丢弃');
    assert.equal(validateScopeParameter('profile bogus').valid, false, '授权入口必须报错');
  });
});

describe('filterUserData —— 权限边界', () => {
  test('profile scope 只给基本信息', () => {
    const out = filterUserData(dbUser, 'profile');
    assert.deepEqual(Object.keys(out).sort(), ['avatar_url', 'bio', 'display_name', 'id', 'username']);
  });

  test('没有 email scope 就绝不返回 email', () => {
    for (const scopes of ['profile', 'openid', 'openid profile', 'applications', '']) {
      const out = filterUserData(dbUser, scopes);
      assert.equal('email' in out, false, `scope=${JSON.stringify(scopes)} 不该含 email`);
    }
  });

  test('有 email scope 才返回 email', () => {
    assert.equal(filterUserData(dbUser, 'email').email, dbUser.email);
    assert.equal(filterUserData(dbUser, 'profile email').email, dbUser.email);
  });

  test('绝不外泄敏感字段 —— 白名单式过滤的关键', () => {
    // 传进来的是整行数据库记录，含 password_hash / session_secret
    for (const scopes of ['profile email', 'admin', 'openid profile email applications admin', '']) {
      const out = filterUserData(dbUser, scopes);
      for (const leaked of ['password_hash', 'session_secret', 'created_at']) {
        assert.equal(leaked in out, false, `scope=${JSON.stringify(scopes)} 泄漏了 ${leaked}`);
      }
    }
  });

  test('admin scope 不会顺带放行 profile/email 字段', () => {
    // hasScopes 里 admin 一票通过，但 filterUserData 是按字段独立判断的
    const out = filterUserData(dbUser, 'admin');
    assert.deepEqual(out, {}, 'admin 本身不包含 profile/email，不该吐任何字段');
  });

  test('未知 scope 什么都不给', () => {
    assert.deepEqual(filterUserData(dbUser, 'bogus'), {});
  });

  test('可选字段缺失时不会出现在结果里', () => {
    const minimal = { id: 'u2', username: 'x', display_name: null };
    const out = filterUserData(minimal, 'profile');
    assert.equal('avatar_url' in out, false);
    assert.equal('bio' in out, false);
    assert.equal(out.id, 'u2');
  });

  test('空 scope 串走默认 profile —— 与 parseScopes 一致', () => {
    const out = filterUserData(dbUser, '');
    assert.equal(out.username, dbUser.username);
    assert.equal('email' in out, false);
  });
});
