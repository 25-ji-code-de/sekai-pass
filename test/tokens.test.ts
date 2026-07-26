/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token 签发 / 校验 / 刷新 / 撤销的测试。
 *
 * 这是整个 SSO 的核心：gateway 与 nako 的 authenticate() 就是查
 * access_tokens 这张表（虽然是各自直接查 D1，不走这里的函数）。
 *
 * 重点钉三条：
 *   1. 刷新时 scope **原样带过来**，不能借刷新提权
 *   2. refresh token **必须轮换**，且删旧插新在同一个 batch 里（原子）
 *   3. 过期判断在 SQL 里做（`expires_at > ?` 绑定当前时间），不是在 JS 里事后过滤
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueTokens,
  validateAccessToken,
  refreshAccessToken,
  revokeAccessToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  cleanupExpiredTokens,
} from '../src/lib/tokens.ts';

/**
 * 记录所有 SQL 与绑定参数的假 D1。
 * `rows` 是按调用顺序排队的 `first()` 返回值。
 */
function fakeDb(rows: unknown[] = []) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const batches: { sql: string; args: unknown[] }[][] = [];
  const queue = [...rows];

  const makeStmt = (sql: string) => ({
    sql,
    args: [] as unknown[],
    bind(...args: unknown[]) {
      this.args = args;
      calls.push({ sql, args });
      return this;
    },
    async first() {
      return queue.length ? queue.shift() : null;
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
    async all() {
      return { results: [] };
    },
  });

  return {
    calls,
    batches,
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      batches.push(stmts.map((s) => ({ sql: s.sql, args: s.args })));
      return stmts.map(() => ({ success: true }));
    },
  } as any;
}

/** 找到第一条包含关键字的 SQL 调用。 */
function findCall(db: any, keyword: string) {
  return db.calls.find((c: any) => c.sql.includes(keyword));
}

describe('issueTokens', () => {
  test('签发成对的 access / refresh token', async () => {
    const db = fakeDb();
    const pair = await issueTokens(db, 'u1', 'hub_client', 'openid profile');

    assert.equal(pair.token_type, 'Bearer');
    assert.equal(pair.expires_in, 3600);
    assert.equal(pair.scope, 'openid profile');
    assert.match(pair.access_token, /^[A-Za-z0-9]{32}$/);
    assert.match(pair.refresh_token!, /^[A-Za-z0-9]{32}$/);
    assert.notEqual(pair.access_token, pair.refresh_token, '两个 token 必须不同');
  });

  test('access token 有效期 1 小时，refresh 30 天', async () => {
    const db = fakeDb();
    const before = Date.now();
    await issueTokens(db, 'u1', 'c1');

    const access = findCall(db, 'INSERT INTO access_tokens');
    const refresh = findCall(db, 'INSERT INTO refresh_tokens');
    // 绑定顺序：token, user_id, client_id, scope, expires_at, created_at
    const accessExp = access.args[4] as number;
    const refreshExp = refresh.args[4] as number;

    assert.ok(accessExp >= before + 3600 * 1000);
    assert.ok(accessExp <= Date.now() + 3600 * 1000);
    assert.ok(refreshExp >= before + 30 * 24 * 3600 * 1000);
  });

  test('scope 缺省为 profile', async () => {
    const db = fakeDb();
    const pair = await issueTokens(db, 'u1', 'c1');
    assert.equal(pair.scope, 'profile');
    assert.equal(findCall(db, 'INSERT INTO access_tokens').args[3], 'profile');
  });

  test('两个 token 都记录了 user_id 与 client_id', async () => {
    const db = fakeDb();
    await issueTokens(db, 'u42', 'client-x', 'email');
    for (const table of ['access_tokens', 'refresh_tokens']) {
      const call = findCall(db, `INSERT INTO ${table}`);
      assert.equal(call.args[1], 'u42', table);
      assert.equal(call.args[2], 'client-x', table);
      assert.equal(call.args[3], 'email', table);
    }
  });

  test('给了 id_token 才带上', async () => {
    assert.equal((await issueTokens(fakeDb(), 'u1', 'c1')).id_token, undefined);
    const withId = await issueTokens(fakeDb(), 'u1', 'c1', 'openid', 'eyJ...');
    assert.equal(withId.id_token, 'eyJ...');
  });

  test('连续签发不重复', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const pair = await issueTokens(fakeDb(), 'u1', 'c1');
      tokens.add(pair.access_token);
      tokens.add(pair.refresh_token!);
    }
    assert.equal(tokens.size, 100, '100 个 token 不应有碰撞');
  });
});

describe('validateAccessToken', () => {
  test('过期判断在 SQL 里做，绑定的是当前时间', async () => {
    const db = fakeDb([null]);
    const before = Date.now();
    await validateAccessToken(db, 'tok');

    const call = findCall(db, 'FROM access_tokens');
    assert.match(call.sql, /expires_at > \?/, '必须在 SQL 里过滤过期');
    assert.equal(call.args[0], 'tok');
    const boundNow = call.args[1] as number;
    assert.ok(boundNow >= before && boundNow <= Date.now(), '第二个参数应是当前时间');
  });

  test('查不到（不存在或已过期）返回 null', async () => {
    assert.equal(await validateAccessToken(fakeDb([null]), 'tok'), null);
  });

  test('命中时返回 userId / clientId / scope', async () => {
    const db = fakeDb([
      { user_id: 'u1', client_id: 'c1', scope: 'openid email', expires_at: 123 },
    ]);
    const info = await validateAccessToken(db, 'tok');
    assert.deepEqual(info, {
      userId: 'u1',
      clientId: 'c1',
      scope: 'openid email',
      expiresAt: 123,
    });
  });

  test('token 作为绑定参数传入，不拼进 SQL', async () => {
    const db = fakeDb([null]);
    await validateAccessToken(db, "' OR 1=1 --");
    const call = findCall(db, 'FROM access_tokens');
    assert.ok(!call.sql.includes('OR 1=1'), 'SQL 里不得出现输入');
    assert.equal(call.args[0], "' OR 1=1 --");
  });
});

describe('refreshAccessToken', () => {
  const storedRefresh = {
    user_id: 'u1',
    client_id: 'c1',
    scope: 'openid profile',
    expires_at: Date.now() + 1000,
  };

  test('refresh token 无效时返回 null，且不签发任何东西', async () => {
    const db = fakeDb([null]);
    assert.equal(await refreshAccessToken(db, 'bad'), null);
    assert.equal(findCall(db, 'INSERT INTO access_tokens'), undefined);
    assert.equal(db.batches.length, 0);
  });

  test('scope 原样带过来 —— 不能借刷新提权', async () => {
    const db = fakeDb([storedRefresh]);
    const pair = await refreshAccessToken(db, 'old-refresh');

    assert.equal(pair!.scope, 'openid profile');
    assert.equal(
      findCall(db, 'INSERT INTO access_tokens').args[3],
      'openid profile',
      '新 access token 的 scope 必须来自存储的 refresh token',
    );
  });

  test('refresh token 必须轮换，且删旧插新在同一个 batch 里', async () => {
    const db = fakeDb([storedRefresh]);
    const pair = await refreshAccessToken(db, 'old-refresh');

    assert.notEqual(pair!.refresh_token, 'old-refresh', '必须换新');
    assert.equal(db.batches.length, 1, '删旧与插新必须原子');

    const [del, ins] = db.batches[0];
    assert.match(del.sql, /DELETE FROM refresh_tokens/);
    assert.equal(del.args[0], 'old-refresh', '删的必须是刚用掉的那个');
    assert.match(ins.sql, /INSERT INTO refresh_tokens/);
    assert.equal(ins.args[0], pair!.refresh_token);
  });

  test('过期判断同样在 SQL 里做', async () => {
    const db = fakeDb([null]);
    await refreshAccessToken(db, 'tok');
    const call = findCall(db, 'FROM refresh_tokens');
    assert.match(call.sql, /expires_at > \?/);
  });

  test('新 access token 与新 refresh token 都是全新的', async () => {
    const db = fakeDb([storedRefresh]);
    const pair = await refreshAccessToken(db, 'old-refresh');
    assert.match(pair!.access_token, /^[A-Za-z0-9]{32}$/);
    assert.match(pair!.refresh_token!, /^[A-Za-z0-9]{32}$/);
    assert.notEqual(pair!.access_token, pair!.refresh_token);
  });

  test('user_id / client_id 沿用存储的值，不接受调用方指定', async () => {
    const db = fakeDb([storedRefresh]);
    await refreshAccessToken(db, 'old-refresh');
    const ins = findCall(db, 'INSERT INTO access_tokens');
    assert.equal(ins.args[1], 'u1');
    assert.equal(ins.args[2], 'c1');
  });
});

describe('撤销', () => {
  test('revokeAccessToken 按 token 删', async () => {
    const db = fakeDb();
    await revokeAccessToken(db, 'tok');
    const call = findCall(db, 'access_tokens');
    assert.match(call.sql, /DELETE/);
    assert.equal(call.args[0], 'tok');
  });

  test('revokeRefreshToken 按 token 删', async () => {
    const db = fakeDb();
    await revokeRefreshToken(db, 'tok');
    const call = findCall(db, 'refresh_tokens');
    assert.match(call.sql, /DELETE/);
    assert.equal(call.args[0], 'tok');
  });

  test('revokeAllUserTokens 两张表都清', async () => {
    const db = fakeDb();
    await revokeAllUserTokens(db, 'u1');
    const sqls = db.calls.map((c: any) => c.sql).join(' | ');
    assert.match(sqls, /access_tokens/);
    assert.match(sqls, /refresh_tokens/);
    for (const call of db.calls) {
      assert.equal(call.args[0], 'u1', '必须按 user_id 限定，不能全表删');
    }
  });

  test('cleanupExpiredTokens 只删已过期的', async () => {
    const db = fakeDb();
    const before = Date.now();
    await cleanupExpiredTokens(db);
    assert.ok(db.calls.length > 0);
    for (const call of db.calls) {
      assert.match(call.sql, /expires_at < \?|expires_at <= \?/, '必须带过期条件');
      const bound = call.args[0] as number;
      assert.ok(bound >= before && bound <= Date.now());
    }
  });
});
