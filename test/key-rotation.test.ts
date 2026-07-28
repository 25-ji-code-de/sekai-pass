/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 签名密钥的中心不变量：**任何被拿来签 ID Token 的钥匙，签的那一刻必须已经
 * 发布在 JWKS 里。** 一旦签名侧和发布侧对「哪些钥匙算数」的判断分了叉，就会
 * 出现「签得出、验不了」——客户端按 OIDC 规范取 JWKS 验签，怎么都验不过。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * 定时任务此前因为 cron 字符串对不上（`"0 0 * * 0"` vs 配置的 `"0 0 * * SUN"`）
 * 一次都没跑过；那一层已修。但**根因**留了下来：
 *
 *   1. `getCurrentSigningKey` 只筛 `status = 'active'`，**不看 expires_at**
 *      —— 轮换一停，它就继续拿过期钥匙签名
 *   2. `getPublicKeys` 把过期超过 7 天宽限期的钥匙剔出 JWKS
 *   3. `rotateSigningKeys` 按 `created_at` 立即吊销旧钥匙 —— 说好的 7 天宽限
 *      实际是 0 天
 *
 * 合起来：线上 `/.well-known/jwks.json` 实测返回 `{"keys":[]}`。
 *
 * ── 这批测试盯什么 ──────────────────────────────────────────────
 *
 *   A. 定时任务真的会触发（cron 字符串必须与配置里的对得上）
 *   B. 签名只用未过期的钥匙；没有就即时补一把 —— 签出来的 kid 必在 JWKS 里
 *   C. JWKS 端点不会返回空集（哪怕冷库/调度停摆）
 *   D. 轮换的判断直接读 D1，不被签名侧的懒补钥匙掩盖；宽限期从轮换那一刻算起
 *
 * B/C/D 组用**真的 SQLite** 跑，不用录 SQL 的假 db —— 这些 bug 长在 WHERE
 * 和时间比较的语义里，假 db 看不见。
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
  getOrCreatePublicKeys,
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

/**
 * KV 的最小实现。
 *
 * 不模拟 expirationTtl —— 真实 KV 到点会自己删，而这里的过期语义全靠钥匙
 * JSON 里的 expiresAt 字段表达（代码就是这么判的）。`raw` / `seed` 暴露出来，
 * 好让测试直接摆出「KV 缓存指向一把已过期钥匙」这种状态。
 */
function memKv() {
  const m = new Map<string, string>();
  return {
    raw: m,
    seed(k: string, v: string) {
      m.set(k, v);
    },
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

/** 直接在 KV 里摆一把「当前钥匙」缓存，expiresAt 由调用方指定。 */
function seedKvCurrent(kv: any, kid: string, expiresAt: number) {
  kv.seed(`signing_key:${kid}`, JSON.stringify({
    kid,
    publicKey: { kid, kty: 'EC' },
    privateKey: { kid, kty: 'EC', d: 'x' },
    algorithm: 'ES256',
    createdAt: expiresAt - 90 * DAY,
    expiresAt,
  }));
  kv.seed('current_signing_key', kid);
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

describe('JWKS 发布哪些钥匙（getPublicKeys）', () => {
  test('没过期的钥匙在 JWKS 里', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 10 * DAY, 80 * DAY);
    assert.deepEqual((await getPublicKeys(db)).map((k: any) => k.kid), [kid]);
  });

  test('刚过期、还在 7 天宽限期内的钥匙**仍然**在 JWKS 里', async () => {
    // 宽限期是为了让还在流通的旧 token 能被验签，这条钉住它没被写反
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 92 * DAY, -2 * DAY);
    assert.deepEqual((await getPublicKeys(db)).map((k: any) => k.kid), [kid]);
  });

  test('过期超过宽限期的钥匙从 JWKS 里消失', async () => {
    const db = realDb();
    const kv = memKv();
    await seedKey(db, kv, 200 * DAY, -110 * DAY);
    assert.deepEqual(await getPublicKeys(db), [], '过了宽限期就不该再发布');
  });

  test('revoked 的钥匙不在 JWKS 里', async () => {
    const db = realDb();
    const kv = memKv();
    await seedKey(db, kv, 10 * DAY, 80 * DAY, 'revoked');
    assert.deepEqual(await getPublicKeys(db), []);
  });
});

describe('签名只用未过期的钥匙，且签出来的 kid 必在 JWKS 里（中心不变量）', () => {
  test('过期的 active 钥匙不再被拿来签名，而是即时轮换出一把新的', async () => {
    /*
     * 这条正是 #36 的核心。此前 getCurrentSigningKey 只筛 status='active'、
     * 不看 expires_at，于是轮换一停就拿过期钥匙继续签 —— 签出来的 kid 不在
     * JWKS 里（getPublicKeys 已经把它剔了）。
     *
     * 现在：签名路径发现没有未过期的 active 钥匙，就即时轮换补一把。
     * 断言的是**不变量本身**：签出来的 kid 一定出现在 JWKS 里。
     */
    const db = realDb();
    const kv = memKv();
    const expiredKid = await seedKey(db, kv, 200 * DAY, -110 * DAY);

    // 传空 KV：强制走 D1，正是老代码只筛 status 的那条路径
    const current = await getCurrentSigningKey(db, memKv(), SECRET);
    assert.notEqual(current.kid, expiredKid, '绝不能再拿那把过期钥匙签名');

    const jwksKids = (await getPublicKeys(db)).map((k: any) => k.kid);
    assert.ok(
      jwksKids.includes(current.kid),
      `签名用的 kid=${current.kid} 必须在 JWKS 里，实际 JWKS=${JSON.stringify(jwksKids)}`,
    );
  });

  test('KV 缓存指向一把已过期钥匙时不被采信，回落到 D1 / 轮换', async () => {
    /*
     * KV 命中此前是无条件返回的。它没有自己的 TTL 语义（代码靠 JSON 里的
     * expiresAt 判断），所以一旦缓存的是过期钥匙，就会一直拿它签。
     */
    const db = realDb();
    const kv = memKv();
    const freshKid = await seedKey(db, kv, 1 * DAY, 89 * DAY); // D1 里有一把好钥匙
    seedKvCurrent(kv, 'stale-expired-kid', Date.now() - 1 * DAY); // KV 指向过期的

    const current = await getCurrentSigningKey(db, kv, SECRET);
    assert.notEqual(current.kid, 'stale-expired-kid', '不能采信过期的 KV 缓存');
    assert.equal(current.kid, freshKid, '应回落到 D1 里那把未过期的');
  });

  test('未过期的 active 钥匙照常直接返回（没有无谓轮换）', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 10 * DAY, 80 * DAY);
    const current = await getCurrentSigningKey(db, memKv(), SECRET);
    assert.equal(current.kid, kid);
    // 没有额外的钥匙被造出来
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM signing_keys').get().n;
    assert.equal(count, 1, '有可用钥匙时不该再造新的');
  });

  test('空库：签名路径补出一把钥匙，并且它就在 JWKS 里', async () => {
    const db = realDb();
    const current = await getCurrentSigningKey(db, memKv(), SECRET);
    const jwksKids = (await getPublicKeys(db)).map((k: any) => k.kid);
    assert.ok(jwksKids.includes(current.kid));
  });
});

describe('JWKS 端点不返回空集（getOrCreatePublicKeys）', () => {
  test('空库时也补出钥匙 —— 响应会被缓存一小时，绝不能是空的', async () => {
    const db = realDb();
    const keys = await getOrCreatePublicKeys(db, memKv(), SECRET);
    assert.ok(keys.length >= 1, 'JWKS 端点决不能发布空集');
  });

  test('所有钥匙都过了宽限期时，补一把新的再发布', async () => {
    const db = realDb();
    const kv = memKv();
    await seedKey(db, kv, 200 * DAY, -110 * DAY); // 唯一的钥匙，过期且超宽限
    assert.deepEqual(await getPublicKeys(db), [], '前提：直接读是空的');

    const keys = await getOrCreatePublicKeys(db, memKv(), SECRET);
    assert.ok(keys.length >= 1, '兜底之后必须非空');
  });

  test('已经有可用钥匙时，不额外造钥匙', async () => {
    const db = realDb();
    const kv = memKv();
    await seedKey(db, kv, 10 * DAY, 80 * DAY);
    await getOrCreatePublicKeys(db, memKv(), SECRET);
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM signing_keys').get().n;
    assert.equal(count, 1, '有可用钥匙就不该走补钥匙那条路');
  });
});

describe('轮换的判断直接读 D1（checkAndRotateKeys）', () => {
  test('空库会生成初始钥匙，且返回 true', async () => {
    const db = realDb();
    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, true, '空库必须轮换出初始钥匙');
    assert.equal((await getPublicKeys(db)).length, 1);
  });

  test('钥匙还年轻、离过期还远时什么都不做', async () => {
    const db = realDb();
    const kv = memKv();
    const kid = await seedKey(db, kv, 10 * DAY, 80 * DAY);
    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, false, '还早得很就轮换 = 白白让旧 token 验不了');
    assert.deepEqual((await getPublicKeys(db)).map((k: any) => k.kid), [kid]);
  });

  test('临近过期（进入 7 天窗口）就提前轮换 —— 新钥匙先发布', async () => {
    /*
     * 主动轮换的意义：新钥匙必须在旧钥匙还能用的时候就已经进 JWKS，
     * 客户端才有时间刷新缓存。所以判断是「离过期 ≤ 7 天」就换，而不是
     * 「已经过期」才换。
     */
    const db = realDb();
    const kv = memKv();
    const oldKid = await seedKey(db, kv, 86 * DAY, 4 * DAY); // 还有 4 天过期
    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, true, '进入 7 天窗口就该提前轮换');

    const jwksKids = (await getPublicKeys(db)).map((k: any) => k.kid);
    assert.ok(jwksKids.includes(oldKid), '旧钥匙在宽限期内仍需发布');
    assert.equal(jwksKids.length, 2, '新旧两把都应在 JWKS 里');
  });

  test('轮换的判断不被签名侧的懒补钥匙掩盖', async () => {
    /*
     * 老实现里 checkAndRotateKeys 先调 getCurrentSigningKey，而后者会懒补
     * 一把新钥匙，于是「按 createdAt 判断年龄」永远看到的是刚建的新钥匙，
     * 90 天检查永远不触发。现在它直接查 D1 的 active 行。
     *
     * 这里摆一把「早就过期」的 active 钥匙：若判断被掩盖，就会返回 false。
     */
    const db = realDb();
    const kv = memKv();
    await seedKey(db, kv, 200 * DAY, -110 * DAY);
    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, true, '过期的 active 钥匙必须触发轮换');
    assert.ok((await getPublicKeys(db)).length >= 1, '轮换后 JWKS 非空');
  });

  test('轮换时旧钥匙的宽限期从轮换那一刻算起，不被立即吊销', async () => {
    /*
     * 老 rotateSigningKeys 按 created_at 立即 revoke：一把 90 天的钥匙在
     * 轮换的同一刻就被吊销，说好的 7 天宽限实际是 0 天。现在按 expires_at
     * 判断，且轮换时把旧 active 的 expires_at 收敛到「此刻」——宽限从现在起算。
     */
    const db = realDb();
    const kv = memKv();
    const oldKid = await seedKey(db, kv, 89 * DAY, 1 * DAY); // 明天到期
    await checkAndRotateKeys(db, memKv(), SECRET);

    const oldRow: any = db.raw
      .prepare('SELECT status FROM signing_keys WHERE kid = ?')
      .get(oldKid);
    assert.equal(oldRow.status, 'rotating', '旧钥匙应转入 rotating，而不是立刻 revoked');
    assert.ok(
      (await getPublicKeys(db)).map((k: any) => k.kid).includes(oldKid),
      '刚轮换下来的旧钥匙仍应发布，供在途 token 验签',
    );
  });

  test('宽限期过后，旧的 rotating 钥匙才被吊销、退出 JWKS', async () => {
    const db = realDb();
    const kv = memKv();
    // 一把 active 好钥匙 + 一把早已超宽限的 rotating 钥匙
    const activeKid = await seedKey(db, kv, 1 * DAY, 89 * DAY);
    const staleKid = await seedKey(db, kv, 100 * DAY, -10 * DAY, 'rotating');

    const rotated = await checkAndRotateKeys(db, memKv(), SECRET);
    assert.equal(rotated, false, 'active 钥匙还年轻，不该轮换');

    const staleRow: any = db.raw
      .prepare('SELECT status FROM signing_keys WHERE kid = ?')
      .get(staleKid);
    assert.equal(staleRow.status, 'revoked', '超宽限的 rotating 钥匙应被吊销');

    const jwksKids = (await getPublicKeys(db)).map((k: any) => k.kid);
    assert.deepEqual(jwksKids, [activeKid], '只剩那把 active 钥匙对外发布');
  });
});
