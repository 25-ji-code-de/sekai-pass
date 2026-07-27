/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 唯一约束冲突的识别，以及「先查后写」竞态下的错误消息。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * 注册是经典的 check-then-act：
 *
 *     SELECT id FROM users WHERE username = ? OR email = ?
 *     if (existing) return 400 "用户名或邮箱已被使用"
 *     INSERT INTO users …
 *
 * 两个并发请求会**同时**通过那个 SELECT，第二个 INSERT 撞上 `UNIQUE`
 * 约束抛异常，被外层 catch 兜成 **500「注册失败，请重试」**。
 *
 * 数据没坏 —— 约束才是真正的守卫。坏的是给用户的**诊断**：他看到一个像
 * 服务端故障的 500，而实际原因是「这个用户名已经被占了」，重试多少次都一样。
 *
 * 这里用 node:sqlite 跑真约束，确认识别函数认得出真实的错误消息 ——
 * 手抄一条消息去测，测的就只是我抄得对不对。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isUniqueConstraintError } from "../src/lib/db-errors.ts";

/** 让 SQLite 真的抛一次唯一约束错误，把它原样拿回来。 */
function realConstraintError(): unknown {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE
    );
  `);
  const insert = db.prepare("INSERT INTO users (id, username, email) VALUES (?, ?, ?)");
  insert.run("u1", "nako", "a@example.test");
  try {
    insert.run("u2", "nako", "b@example.test");
    throw new Error("前置条件不成立：第二次插入居然成功了");
  } catch (e) {
    return e;
  }
}

/** 主键冲突（复合主键，对应 client_keys）。 */
function realPrimaryKeyError(): unknown {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE client_keys (
      client_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      PRIMARY KEY (client_id, key_id)
    );
  `);
  const insert = db.prepare("INSERT INTO client_keys (client_id, key_id) VALUES (?, ?)");
  insert.run("app1", "k1");
  try {
    insert.run("app1", "k1");
    throw new Error("前置条件不成立：第二次插入居然成功了");
  } catch (e) {
    return e;
  }
}

describe("isUniqueConstraintError —— 对着真实错误", () => {
  test("认得出 UNIQUE 列冲突", () => {
    const err = realConstraintError();
    assert.equal(isUniqueConstraintError(err), true, `没认出来：${String(err)}`);
  });

  test("认得出复合主键冲突", () => {
    const err = realPrimaryKeyError();
    assert.equal(isUniqueConstraintError(err), true, `没认出来：${String(err)}`);
  });

  test("真实消息里确实带着我们依赖的关键字（不是我猜的）", () => {
    const msg = String((realConstraintError() as Error).message);
    assert.match(
      msg,
      /UNIQUE constraint failed|SQLITE_CONSTRAINT/i,
      `SQLite 的消息变了：${msg}`,
    );
  });
});

describe("isUniqueConstraintError —— 不该误报", () => {
  test("普通错误不算", () => {
    for (const e of [
      new Error("network down"),
      new Error("D1_ERROR: no such table: users"),
      new TypeError("x is not a function"),
      null,
      undefined,
      "",
    ]) {
      assert.equal(isUniqueConstraintError(e), false, `误报：${String(e)}`);
    }
  });

  test("NOT NULL 约束不算唯一约束", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a TEXT NOT NULL)");
    let err;
    try {
      db.prepare("INSERT INTO t (a) VALUES (?)").run(null);
    } catch (e) {
      err = e;
    }
    assert.ok(err, "前置条件不成立：NOT NULL 没有拦住");
    assert.equal(
      isUniqueConstraintError(err),
      false,
      `NOT NULL 冲突被当成了唯一约束：${String(err)}`,
    );
  });

  test("字符串形式的错误也能处理，不抛", () => {
    assert.equal(isUniqueConstraintError("UNIQUE constraint failed: users.username"), true);
    assert.equal(isUniqueConstraintError("something else"), false);
  });
});

describe("复合主键的消息形状（记录一个曾经踩过的坑）", () => {
  test("复合主键冲突时消息里是多列，取不出单一列名", () => {
    /*
     * 这里一度有个 `conflictingColumn()`，想据此给出「用户名已被使用」
     * 这种更精确的消息。复合主键的真实消息是：
     *
     *     UNIQUE constraint failed: ck.a, ck.b
     *
     * 一个 `([\w.]+)` 的正则会取出第一列，看起来成功了，实际是误导。
     * 加上注册的非并发路径本来就只能给合并消息，那个函数已删。
     *
     * 这条留着是为了记住消息的真实形状 —— 以后谁想做精确消息，
     * 先看这里。
     */
    const msg = String((realPrimaryKeyError() as Error).message);
    assert.match(msg, /UNIQUE constraint failed: \w+\.\w+, \w+\.\w+/, `消息形状变了：${msg}`);
  });
});

describe("调用点确实用上了", () => {
  /*
   * 光有识别函数不够 —— 得确认那两处 catch 真的调用了它。
   * 这两条是静态检查：行为层面的覆盖要真跑并发，成本远大于收益。
   */
  const root = join(import.meta.dirname, "..");

  test("注册的 catch 里把唯一约束翻成 400", () => {
    const src = readFileSync(join(root, "src/lib/api.ts"), "utf8");
    const fn = /apiRouter\.post\("\/auth\/register"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    assert.ok(fn, "找不到注册的 handler");
    assert.match(fn, /isUniqueConstraintError\(error\)/, "注册的 catch 没有识别唯一约束");
    assert.match(
      fn,
      /return c\.json\(\{ error: "用户名或邮箱已被使用" \}, 400\);[\s\S]{0,80}\}\s*\n\s*console\.error\("Registration error/,
      "翻译出的消息与非并发路径不一致，或没有放在 500 之前",
    );
  });

  test("addClientKey 的 catch 里给出与非并发路径相同的字段错误", () => {
    const src = readFileSync(join(root, "src/lib/client-keys.ts"), "utf8");
    assert.match(src, /isUniqueConstraintError\(error\)/, "addClientKey 没有识别唯一约束");
    // 两处消息必须逐字相同 —— 同一件事不该按时机给出两种说法
    const messages = [...src.matchAll(/message: `key_id "\$\{keyId\}" 已存在，换一个或先删除旧的`/g)];
    assert.equal(messages.length, 2, `期望两处相同的消息，实际 ${messages.length} 处`);
  });

  test("非唯一约束的错误仍然往上抛，不被吞掉", () => {
    const src = readFileSync(join(root, "src/lib/client-keys.ts"), "utf8");
    assert.match(src, /\}\s*\n\s*throw error;\s*\n\s*\}/, "addClientKey 把所有错误都吞了");
  });
});
