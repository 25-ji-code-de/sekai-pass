/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 签名密钥轮换：定时任务必须真的会触发，过期的钥匙必须真的会被换掉。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * `scheduled` 里写的是：
 *
 *     if (event.cron === "0 0 * * 0") { await checkAndRotateKeys(...) }
 *
 * 而 `wrangler.toml` 里配的是 `crons = ["0 0 * * SUN"]`。
 * Cloudflare 传给 `event.cron` 的**就是配置里那一行原文** —— 两个字符串
 * 不相等，于是 `checkAndRotateKeys` 一次都没跑过。
 * 它在整个仓里只有这一个调用点。
 *
 * ── 为什么这不只是「少转了一次密钥」 ────────────────────────────
 *
 *   1. 密钥 90 天过期（`expiresAt = createdAt + 90d`），而轮换从不发生
 *   2. `getCurrentSigningKey` 查的是 `status = 'active'`，**不看 expires_at**
 *      —— 于是继续拿那把过期的钥匙签 ID Token
 *   3. `getPublicKeys` 会把过期超过 7 天宽限期的钥匙排除出 JWKS
 *
 * 合起来就是：**用一把没有发布在 JWKS 里的钥匙签 token。**
 *
 * 线上实测（2026-07-27）：
 *
 *     $ curl -s https://id.nightcord.de5.net/.well-known/jwks.json
 *     {"keys":[]}
 *
 * 同时 discovery 里声明着 `id_token_signing_alg_values_supported:
 * ["ES256","RS256"]`。按 OIDC 规范取 JWKS 验签的客户端，一个都验不过。
 *
 * ── 这批测试盯什么 ──────────────────────────────────────────────
 *
 * 不是「`scheduled` 里不许出现某个字符串」，而是两件会再次犯的事：
 *   A. 代码里比对的 cron 字符串，必须与配置文件里真实存在的对得上
 *   B. 过期的钥匙进不了 JWKS —— 这条钉住的是「为什么第 1 条会致命」
 *
 * B 组用**真的 SQLite** 跑，不用录 SQL 的假 db。
 * 这个 bug 就长在 WHERE 的语义里，假 db 看不见 WHERE。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripJsComments } from './support.ts';

import {
  getPublicKeys,
  checkAndRotateKeys,
  getCurrentSigningKey,
  generateSigningKey,
  storeSigningKey,
} from '../src/lib/keys.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ─────────────────────────────────────────────────────────────────
// A. 定时任务真的会触发
// ─────────────────────────────────────────────────────────────────

describe('定时任务真的会触发密钥轮换', () => {
  const src = read('src/index.ts');
  /*
   * 剥注释。上面那段说明里逐字引用了 `event.cron === "0 0 * * 0"`，
   * 不剥的话「代码里不再比对这个字符串」会被自己的解释绊倒 ——
   * 这一族的坑我已经踩过好几次了。
   *
   * 必须用 `stripJsComments`：index.ts 里 `app.use("/api/*", ...)` 的
   * 字符串里带 `/*`，一行正则会从那里开始吃掉一大段代码。
   */
  const code = stripJsComments(src);

  const scheduled = /async scheduled\([\s\S]*?\n  \}/.exec(code)?.[0] ?? '';

  test('找得到 scheduled 处理器（否则下面几条是空跑）', () => {
    assert.ok(scheduled, 'src/index.ts 里找不到 scheduled 处理器');
  });

  test('它确实调用了 checkAndRotateKeys', () => {
    assert.match(
      scheduled,
      /checkAndRotateKeys\(/,
      'scheduled 不调 checkAndRotateKeys —— 那密钥永远不会轮换',
    );
  });

  test('它比对的每个 cron 字符串都必须在 wrangler 配置里真实存在', () => {
    /*
     * 这是那个 bug 的**泛化形状**，不是「不许写 0 0 * * 0」。
     *
     * 只要有人再拿 event.cron 跟一个字面量比，这条就要求那个字面量
     * 必须与 wrangler.toml.example 里 crons 数组中的某一项逐字相同。
     * 写错一个字（SUN vs 0）就红，而不是等三个月后发现密钥没转过。
     */
    const compared = [...scheduled.matchAll(/event\.cron\s*===?\s*["']([^"']+)["']/g)].map(
      (m) => m[1],
    );

    const config = read('wrangler.toml.example');
    const cronsLine = /^\s*crons\s*=\s*\[([^\]]*)\]/m.exec(config);
    assert.ok(cronsLine, 'wrangler.toml.example 里找不到 crons');

    const declared = [...cronsLine[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(declared.length > 0, 'crons 是空的 —— 那 scheduled 永远不会被调用');

    const orphans = compared.filter((c) => !declared.includes(c));
    assert.deepEqual(
      orphans,
      [],
      `scheduled 里比对的 cron 字符串在配置里不存在：${orphans.join(', ')}\n` +
        `配置里声明的是：${declared.join(', ')}\n` +
        'Cloudflare 传给 event.cron 的就是配置里那一行原文，对不上就永远不执行',
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// B. 过期的钥匙进不了 JWKS（真 SQL）
// ─────────────────────────────────────────────────────────────────

const SIGNING_KEYS_DDL = `
  CREATE TABLE signing_keys (
    kid TEXT PRIMARY KEY,
    public_key_jwk TEXT NOT NULL,
    private_key_jwk TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
  );
`;

/**
 * D1 接口的最小实现，底下是**真的 SQLite**。
 *
 * 特意不用仓里现成的 fakeDb（录 SQL、返回预设行）—— 那种 db 看不见 WHERE。
 * 而这一组要验的恰恰是 WHERE 的语义：哪些行会被排除出 JWKS。
 * 用假 db 的话，无论 WHERE 写成什么，测试都一样绿。
 */
function realDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SIGNING_KEYS_DDL);

  const wrap = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => wrap(sql, a),
    async first() {
      return db.prepare(sql).get(...(args as never[])) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...(args as never[])), success: true };
    },
    async run() {
      db.prepare(sql).run(...(args as never[]));
      return { success: true };
    },
  });

  return {
    raw: db,
    prepare: (sql: string) => wrap(sql),
    async batch(stmts: any[]) {
      for (const s of stmts) await s.run();
      return stmts.map(() => ({ success: true }));
    },
  } as any;
}

/** KV 的最小实现。 */
function memKv() {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
    size: () => m.size,
  } as any;
}

const DAY = 24 * 60 * 60 * 1000;

const SECRET = 'k'.repeat(32);

/**
 * 造一把**真的**钥匙，再把时间戳回填到想要的位置。
 *
 * 第一版直接 INSERT 了一个 `'encrypted-placeholder'` 当私钥，结果
 * getCurrentSigningKey 解密时抛 `InvalidCharacterError`（atob 收到非
 * base64）—— 三条测试红在解密上，而不是红在它们要验的东西上。
 *
 * 用真的 generateSigningKey + storeSigningKey 造，再用 UPDATE 改时间，
 * 这样测的才是「时间到了会怎样」，而不是「假数据能不能解析」。
 */
async function seedKey(
  db: any,
  kv: any,
  createdAgo: number,
  expiresIn: number,
  status = 'active',
): Promise<string> {
  const key = await generateSigningKey();
  await storeSigningKey(db, kv, key, SECRET);
  db.raw
    .prepare('UPDATE signing_keys SET created_at = ?, expires_at = ?, status = ? WHERE kid = ?')
    .run(Date.now() - createdAgo, Date.now() + expiresIn, status, key.kid);
  return key.kid;
}

describe('JWKS 里有什么，签名用的是什么', () => {
  test('没过期的钥匙在 JWKS 里', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 10 * DAY, 80 * DAY);
    const keys = await getPublicKeys(db);
    assert.deepEqual(keys.map((k: any) => k.kid), [kid]);
  });

  test('刚过期、还在 7 天宽限期内的钥匙**仍然**在 JWKS 里', async () => {
    // 宽限期是为了让还在流通的旧 token 能被验签，这条钉住它没被写反
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 92 * DAY, -2 * DAY);
    const keys = await getPublicKeys(db);
    assert.deepEqual(keys.map((k: any) => k.kid), [kid]);
  });

  test('过期超过宽限期的钥匙从 JWKS 里消失 —— 线上空 JWKS 就是这么来的', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 200 * DAY, -110 * DAY);
    const keys = await getPublicKeys(db);
    assert.deepEqual(
      keys,
      [],
      '这条**期望**它消失。JWKS 变空本身是对的 —— 错的是轮换没跑，' +
        '让一把过期这么久的钥匙成了唯一的钥匙',
    );
  });

  test('revoked 的钥匙不在 JWKS 里', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 10 * DAY, 80 * DAY, 'revoked');
    assert.deepEqual(await getPublicKeys(db), []);
  });

  test('过期的钥匙照样会被当成签名钥匙取出来（危险的那一半）', async () => {
    /*
     * getCurrentSigningKey 只筛 status = 'active'，**不看 expires_at**。
     *
     * 这条测试记录的是现状，不是在赞同它：轮换正常跑的时候这不会发生，
     * 因为不会存在「过期很久还是 active」的钥匙。但一旦轮换停了，
     * 它就会安静地拿一把 JWKS 里没有的钥匙继续签 —— 也就是线上发生的事。
     *
     * 若将来给它加上过期检查，这条会红。**那时候应当改这条测试，
     * 而不是把过期检查去掉。**
     */
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 200 * DAY, -110 * DAY);
    // 特意传一个空的 KV：强制走 D1 那条路径，也就是只筛 status 的那条
    const current = await getCurrentSigningKey(db, memKv(), SECRET);
    assert.ok(current, '过期的 active 钥匙仍会被取出来');
    assert.equal(current!.kid, kid);

    // 而它同时不在 JWKS 里 —— 两句合起来就是「签得出、验不了」
    assert.deepEqual(await getPublicKeys(db), []);
  });
});

describe('checkAndRotateKeys 的判断', () => {
  test('一把钥匙都没有时会生成初始钥匙', async () => {
    /*
     * 断言的是**可观察的结果**（跑完之后 JWKS 里有钥匙），不是返回值。
     *
     * 返回值在这里是 `false`，而且这不是 bug：钥匙是 getCurrentSigningKey
     * 内部懒创建的，checkAndRotateKeys 拿到的已经是一把刚建好的新钥匙，
     * 于是「没到 90 天」→ 返回 false。
     *
     * 顺带发现：checkAndRotateKeys 里的 `if (!currentKey)` 分支因此
     * **不可达** —— getCurrentSigningKey 在 D1 可写时永远不返回 null。
     * 那是无害的防御性代码，本 PR 不动它，只在这里记一笔，
     * 免得下次有人照着返回值去推断行为。
     */
    const db = realDb();
    await checkAndRotateKeys(db, memKv(), SECRET);
    const keys = await getPublicKeys(db);
    assert.equal(keys.length, 1, '跑完之后 JWKS 里应当有一把钥匙');
  });

  test('钥匙还年轻时什么都不做', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 10 * DAY, 80 * DAY);
    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, false, '还没到 90 天就轮换 = 白白让旧 token 验不了');
    assert.deepEqual((await getPublicKeys(db)).map((k: any) => k.kid), [kid]);
  });

  test('钥匙超过 90 天时会轮换，且轮换后 JWKS 不为空', async () => {
    /*
     * 这条是整件事的收口：**只要定时任务真的跑起来，线上那个空 JWKS
     * 就会自己恢复。**
     */
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 200 * DAY, -110 * DAY);
    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, true, '过了 90 天却没轮换');

    const keys = await getPublicKeys(db);
    assert.ok(keys.length >= 1, '轮换之后 JWKS 仍然是空的');
  });
});
