/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 数据库错误的识别。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 好几处代码是「先查有没有，没有就插」：
 *
 *     SELECT id FROM users WHERE username = ? OR email = ?
 *     if (existing) return 400 "用户名或邮箱已被使用"
 *     INSERT INTO users …
 *
 * 两个并发请求会**同时**通过那个 SELECT，然后第二个 INSERT 撞上
 * `UNIQUE` 约束抛异常，被外层 catch 兜成 500「注册失败，请重试」。
 *
 * 数据没坏 —— 约束才是真正的守卫，它拦住了重复账号。坏的是**给用户的
 * 诊断**：他看到的是一个像服务端故障的 500，而实际原因是「这个用户名
 * 已经被占了」，重试多少次都一样。
 *
 * 所以：SELECT 那一步是为了给出好消息，约束是为了保证正确性。
 * 两者都要有，而约束触发时也得给出同样的好消息。
 */

/**
 * 是不是唯一约束（含主键）冲突。
 *
 * D1 把 SQLite 的错误原样透出来，形如：
 *
 *   `D1_ERROR: UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT`
 *
 * 这里同时认 `UNIQUE constraint failed` 与 `SQLITE_CONSTRAINT` ——
 * 靠消息文本判断本来就脆，多认一种写法比少认一种好：**少认会退回 500**
 * （也就是现状），多认最坏是把别的约束错误也说成「已被占用」。
 */
export function isUniqueConstraintError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return (
    /UNIQUE\s+constraint\s+failed/i.test(message) ||
    /SQLITE_CONSTRAINT(_UNIQUE|_PRIMARYKEY)?\b/i.test(message)
  );
}

/*
 * 这里一度还有个 `conflictingColumn(error)`，想从消息里取出到底哪一列重了，
 * 好给出「用户名已被使用」而不是「用户名或邮箱已被使用」。删掉了，两个原因：
 *
 *   1. 复合主键的消息是 `UNIQUE constraint failed: ck.a, ck.b` ——
 *      「哪一列冲突」对复合键没有单一答案，返回第一列是误导。
 *   2. 更要紧的是：注册那条**非并发**路径用的是
 *      `WHERE username = ? OR email = ?`，本来就只能给出合并消息。
 *      只把并发路径做精确，等于同一件事按时机给出两种详细程度的回答。
 *
 * 真要精确到字段，得先把那个 SELECT 拆成两次查询 —— 那是另一件事。
 */
