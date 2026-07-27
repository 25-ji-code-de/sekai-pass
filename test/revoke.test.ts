/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RFC 7009 撤销：hint 只决定先试哪种，不决定试不试。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * `/oauth/revoke` 里原本是两段并列的判断：
 *
 *     if (!hint || hint === "refresh_token") { ...试 refresh... }
 *     if (!hint || hint === "access_token")  { ...试 access...  }
 *
 * hint 一旦给定，另一段就被**整个跳过**。于是：
 *
 *   带 hint=refresh_token 撤一个 access token → 什么都没删，**返回 200**
 *   带 hint=access_token  撤一个 refresh token → 什么都没删，**返回 200**
 *
 * 而 RFC 7009 §2.1 明确要求：
 *   > If the server is unable to locate the token using the given hint,
 *   > it MUST extend its search across all of its supported token types.
 *
 * 「登出看起来成功了，而 token 还活着」是安全操作里最坏的一种失败：
 * 没有任何信号，用户以为已经登出。refresh token 有效期 30 天。
 *
 * 现在所有客户端发的 hint 都是对的（sekai-auth 分两次撤，各自配对），
 * 所以这是**潜伏**的 —— 但 hint 按规范本来就允许出错，那正是它叫 hint 的原因。
 *
 * ── 为什么用真 SQLite ───────────────────────────────────────────
 *
 * 这个 bug 是「哪条分支会被执行」的问题。录 SQL 的假 db 只能告诉你
 * 「发过哪些语句」，而这里要问的是「**那一行到底还在不在**」。
 * 同一天在 sekai-worker-kit 已经栽过一次：假 db 让 JOIN 与整条 WHERE
 * 删掉都是 0 红。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { revokeToken } from '../src/lib/revoke.ts';

const DDL = `
  CREATE TABLE access_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
`;

/** D1 接口的最小实现，底下是真的 SQLite（含 meta.changes）。 */
function realDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);

  const wrap = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => wrap(sql, a),
    async first() {
      return db.prepare(sql).get(...(args as never[])) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...(args as never[])), success: true };
    },
    async run() {
      const info = db.prepare(sql).run(...(args as never[]));
      /*
       * `meta.changes` 是这一组测试的关键。
       *
       * 原来的代码用 D1 的 `success` 当「删到了吗」的判据 —— 而 success
       * 表示**语句执行成功**，删了 0 行也是 true。于是那个判断恒为真。
       */
      return { success: true, meta: { changes: Number(info.changes ?? 0) } };
    },
  });

  return {
    raw: db,
    prepare: (sql: string) => wrap(sql),
  } as any;
}

const now = Date.now();

function seedAccess(db: any, token: string, user = 'u1', client = 'c1') {
  db.raw
    .prepare(
      `INSERT INTO access_tokens (token, user_id, client_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(token, user, client, now + 3600_000, now);
}

function seedRefresh(db: any, token: string, user = 'u1', client = 'c1') {
  db.raw
    .prepare(
      `INSERT INTO refresh_tokens (token, user_id, client_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(token, user, client, now + 30 * 86400_000, now);
}

const countAccess = (db: any, token: string) =>
  db.raw.prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE token = ?').get(token).n;
const countRefresh = (db: any, token: string) =>
  db.raw.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE token = ?').get(token).n;

describe('hint 与实际类型一致时（现有客户端就是这么发的）', () => {
  test('hint=access_token 撤 access token', async () => {
    const db = realDb();
    seedAccess(db, 'at1');
    assert.equal(await revokeToken(db, 'at1', 'access_token'), true);
    assert.equal(countAccess(db, 'at1'), 0);
  });

  test('hint=refresh_token 撤 refresh token', async () => {
    const db = realDb();
    seedRefresh(db, 'rt1');
    assert.equal(await revokeToken(db, 'rt1', 'refresh_token'), true);
    assert.equal(countRefresh(db, 'rt1'), 0);
  });

  test('不给 hint 也能撤两种', async () => {
    const db = realDb();
    seedAccess(db, 'at1');
    seedRefresh(db, 'rt1');
    assert.equal(await revokeToken(db, 'at1', null), true);
    assert.equal(await revokeToken(db, 'rt1', undefined), true);
    assert.equal(countAccess(db, 'at1'), 0);
    assert.equal(countRefresh(db, 'rt1'), 0);
  });
});

describe('hint 给错时仍然必须撤掉（RFC 7009 §2.1）', () => {
  test('hint=refresh_token，但给的是 access token', async () => {
    /*
     * 这条就是那个 bug。修之前：什么都没删，而端点返回 200 ——
     * 用户以为登出了，token 还能继续用。
     */
    const db = realDb();
    seedAccess(db, 'at1');
    const ok = await revokeToken(db, 'at1', 'refresh_token');
    assert.equal(ok, true, 'hint 给错就放弃了 —— 规范要求扩展搜索到所有类型');
    assert.equal(countAccess(db, 'at1'), 0, 'access token 还在库里');
  });

  test('hint=access_token，但给的是 refresh token', async () => {
    // 这一半更糟：refresh token 有效期 30 天
    const db = realDb();
    seedRefresh(db, 'rt1');
    const ok = await revokeToken(db, 'rt1', 'access_token');
    assert.equal(ok, true);
    assert.equal(countRefresh(db, 'rt1'), 0, 'refresh token 还在库里');
  });

  test('无法识别的 hint 当成没给', async () => {
    // 规范没规定必须报错，而放弃撤销是最坏的选择
    const db = realDb();
    seedAccess(db, 'at1');
    assert.equal(await revokeToken(db, 'at1', 'urn:example:weird'), true);
    assert.equal(countAccess(db, 'at1'), 0);
  });
});

describe('撤 refresh token 会连带撤掉同一授权下的 access token', () => {
  test('同用户同客户端的 access token 一并失效', async () => {
    /*
     * RFC 7009 §2.1 的 SHOULD：撤 refresh token 时，
     * 基于同一授权发出的 access token 也应当失效。
     * 否则「登出」之后，还没到期的 access token 仍然能用最多一小时。
     */
    const db = realDb();
    seedRefresh(db, 'rt1', 'u1', 'c1');
    seedAccess(db, 'at1', 'u1', 'c1');
    seedAccess(db, 'at-other', 'u1', 'c2'); // 别的客户端，不该被牵连

    await revokeToken(db, 'rt1', 'refresh_token');

    assert.equal(countAccess(db, 'at1'), 0, '同一授权下的 access token 没被撤掉');
    assert.equal(countAccess(db, 'at-other'), 1, '把别的客户端的 token 也撤了');
  });
});

describe('未知 token', () => {
  test('返回 false，但调用方不该因此改状态码', async () => {
    /*
     * RFC 7009 §2.2 要求 token 不存在或无效时**也返回 200**。
     * 这个返回值只是给调用方做遥测/日志用的，不是错误信号。
     *
     * 路由那边写了对应的注释；这条测试钉的是「函数如实返回没删到」，
     * 好让将来有人真想统计时有得可用。
     */
    const db = realDb();
    assert.equal(await revokeToken(db, 'nope', null), false);
    assert.equal(await revokeToken(db, 'nope', 'access_token'), false);
    assert.equal(await revokeToken(db, 'nope', 'refresh_token'), false);
  });

  test('删了 0 行不能算成功 —— 原来的 bug 就在这儿', async () => {
    /*
     * 原代码判的是 D1 的 `success`，而它表示**语句执行成功**，
     * 删 0 行也是 true。于是「撤销成功」恒为真，
     * 上面那几条「hint 给错」的测试也就永远发现不了问题。
     */
    const db = realDb();
    seedRefresh(db, 'rt1');
    // 存在的是 rt1，撤 at-missing 应当明确返回 false
    assert.equal(await revokeToken(db, 'at-missing', 'access_token'), false);
    assert.equal(countRefresh(db, 'rt1'), 1, '不该误伤别的 token');
  });
});
