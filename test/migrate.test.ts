/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * scripts/migrate.mjs 的纯逻辑部分。
 *
 * 与 wrangler 打交道的部分没法在这里测（要真库），但决定「哪几条该跑」的
 * 判断是纯函数 —— 而那正是唯一会出错的地方：漏掉一列，线上库就少一列，
 * 之后所有查询都 500。
 *
 * 另外这里锁住真实的 migrations/*.sql：解析器认的是
 * `ALTER TABLE <表> ADD COLUMN <列>` 这个形状，谁哪天换个写法，
 * 脚本会静默地把它当成「可重复执行的语句」直接跑 —— 于是第二次迁移又炸了，
 * 而且炸在一个看起来跟这次改动毫无关系的地方。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  stripSqlComments,
  parseMigration,
  planColumnAdds,
} from "../scripts/migrate.mjs";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

describe("stripSqlComments", () => {
  test("去掉整行注释", () => {
    assert.equal(stripSqlComments("-- 说明\nSELECT 1;").trim(), "SELECT 1;");
  });

  test("去掉行尾注释但保留语句", () => {
    assert.equal(stripSqlComments("SELECT 1; -- 说明").trim(), "SELECT 1;");
  });

  test("注释里的分号不会被当成语句分隔", () => {
    // 真实迁移文件的注释里就有整条 SQL（认领 recipe），带分号
    const { idempotent } = parseMigration(
      "-- UPDATE t SET a = 1; SELECT 2;\nCREATE TABLE x (a INT);",
    );
    assert.equal(idempotent.length, 1);
    assert.match(idempotent[0], /^CREATE TABLE x/);
  });

  test("行数不变（便于对照原文件定位）", () => {
    const src = "a\n-- b\nc\n";
    assert.equal(stripSqlComments(src).split("\n").length, src.split("\n").length);
  });
});

describe("parseMigration：区分可重复执行与加列", () => {
  test("CREATE TABLE / INDEX 归入可重复执行", () => {
    const { idempotent, columnAdds } = parseMigration(`
      CREATE TABLE IF NOT EXISTS t (a INT);
      CREATE INDEX IF NOT EXISTS i ON t(a);
    `);
    assert.equal(idempotent.length, 2);
    assert.equal(columnAdds.length, 0);
  });

  test("ALTER TABLE ADD COLUMN 被单独拆出来", () => {
    const { idempotent, columnAdds } = parseMigration(
      "ALTER TABLE applications ADD COLUMN owner_user_id TEXT;",
    );
    assert.equal(idempotent.length, 0);
    assert.deepEqual(columnAdds.map((c) => [c.table, c.column]), [
      ["applications", "owner_user_id"],
    ]);
  });

  test("省略 COLUMN 关键字也认（SQLite 允许）", () => {
    const { columnAdds } = parseMigration("ALTER TABLE t ADD c TEXT;");
    assert.deepEqual(columnAdds.map((c) => c.column), ["c"]);
  });

  test("大小写与多余空白不影响识别", () => {
    const { columnAdds } = parseMigration(
      "alter   table\n  t\n  add   column   c  TEXT;",
    );
    assert.deepEqual(columnAdds.map((c) => [c.table, c.column]), [["t", "c"]]);
  });

  test("带 NOT NULL DEFAULT 的列也认得出列名", () => {
    const { columnAdds } = parseMigration(
      "ALTER TABLE applications ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none';",
    );
    assert.deepEqual(columnAdds.map((c) => c.column), [
      "token_endpoint_auth_method",
    ]);
  });

  test("空语句与纯注释文件不产生任何语句", () => {
    assert.deepEqual(parseMigration("-- 只有注释\n\n;;\n"), {
      idempotent: [],
      columnAdds: [],
    });
  });

  test("ALTER TABLE 的其他形式不会被误当成加列", () => {
    // DROP COLUMN / RENAME 不是我们处理的形状，应当留在 idempotent 里原样执行
    const { idempotent, columnAdds } = parseMigration(
      "ALTER TABLE t RENAME TO t2;",
    );
    assert.equal(columnAdds.length, 0);
    assert.equal(idempotent.length, 1);
  });
});

describe("planColumnAdds：只补缺的列", () => {
  const adds = [
    { table: "applications", column: "a", sql: "ALTER TABLE applications ADD COLUMN a TEXT" },
    { table: "applications", column: "b", sql: "ALTER TABLE applications ADD COLUMN b TEXT" },
  ];

  test("全新表：两条都要跑", () => {
    const plan = planColumnAdds(adds, new Map([["applications", new Set()]]));
    assert.deepEqual(plan.map((p) => p.column), ["a", "b"]);
  });

  test("迁到一半：只补缺的那条", () => {
    const plan = planColumnAdds(
      adds,
      new Map([["applications", new Set(["a"])]]),
    );
    assert.deepEqual(plan.map((p) => p.column), ["b"]);
  });

  test("已经迁完：一条都不跑（这才是「重跑不报错」）", () => {
    const plan = planColumnAdds(
      adds,
      new Map([["applications", new Set(["a", "b"])]]),
    );
    assert.deepEqual(plan, []);
  });

  test("表还不存在时按「一列都没有」处理", () => {
    // pragma_table_info 对不存在的表返回空集；此时 Map 里根本没有这个键
    const plan = planColumnAdds(adds, new Map());
    assert.equal(plan.length, 2);
  });

  test("同名列在别的表上不算数", () => {
    const cross = [
      { table: "t1", column: "a", sql: "ALTER TABLE t1 ADD COLUMN a TEXT" },
      { table: "t2", column: "a", sql: "ALTER TABLE t2 ADD COLUMN a TEXT" },
    ];
    const plan = planColumnAdds(cross, new Map([["t1", new Set(["a"])]]));
    assert.deepEqual(plan.map((p) => p.table), ["t2"]);
  });
});

describe("锁住真实的 migrations/*.sql", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  test("目录里有迁移文件（否则下面几条是空跑）", () => {
    assert.ok(files.length > 0);
  });

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    test(`${file}：每条 ALTER 都能解析出表名与列名`, () => {
      const stripped = stripSqlComments(sql);
      const alterCount = (stripped.match(/\bALTER\s+TABLE\b/gi) ?? []).length;
      const { columnAdds, idempotent } = parseMigration(sql);
      const unparsed = idempotent.filter((s) => /^ALTER\s+TABLE/i.test(s));

      assert.deepEqual(
        unparsed,
        [],
        "有 ALTER TABLE 没被识别成加列 —— 它会被当作可重复语句直接跑，" +
          "第二次迁移就会炸",
      );
      assert.equal(columnAdds.length, alterCount);
    });

    test(`${file}：可重复执行的部分确实都带 IF NOT EXISTS`, () => {
      const { idempotent } = parseMigration(sql);
      for (const stmt of idempotent) {
        if (/^CREATE\s+(TABLE|INDEX|VIEW|TRIGGER)/i.test(stmt)) {
          assert.match(
            stmt,
            /IF\s+NOT\s+EXISTS/i,
            `这条 CREATE 没有 IF NOT EXISTS，重跑会报 already exists：\n${stmt.slice(0, 80)}`,
          );
        }
      }
    });
  }

  test("0001 覆盖了开放平台用到的全部新列", () => {
    // 少一列 = 线上库少一列 = 之后所有涉及它的查询 500。
    // 这份清单与 src/lib/applications.ts 的 SELECT 是同一组字段。
    const { columnAdds } = parseMigration(
      readFileSync(join(MIGRATIONS_DIR, "0001_open_platform.sql"), "utf8"),
    );
    const cols = new Set(
      columnAdds.filter((c) => c.table === "applications").map((c) => c.column),
    );
    for (const need of [
      "owner_user_id",
      "token_endpoint_auth_method",
      "description",
      "homepage_url",
      "updated_at",
    ]) {
      assert.ok(cols.has(need), `0001 少了 applications.${need}`);
    }
  });

  test("0001 建了 client_auth 依赖的两张表", () => {
    // src/lib/client-auth.ts 一直在查这两张表，但它们此前不在 schema.sql 里
    const { idempotent } = parseMigration(
      readFileSync(join(MIGRATIONS_DIR, "0001_open_platform.sql"), "utf8"),
    );
    const created = idempotent
      .map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/i.exec(s)?.[1])
      .filter(Boolean);
    assert.ok(created.includes("client_keys"));
    assert.ok(created.includes("jwt_replay_cache"));
  });

  test("schema.sql 与迁移不会分叉", () => {
    /*
     * 全新部署跑 schema.sql，存量部署跑迁移 —— 两条路必须到同一个 schema。
     * 分叉的后果很隐蔽：本地（全新库）一切正常，线上（迁过来的库）少一列，
     * 于是只有生产环境 500。
     *
     * 这里只查一个方向：迁移加的列，schema.sql 里也得有。
     * 反过来（schema 有而迁移没有）是允许的 —— 那说明这列本来就是老列。
     */
    const schema = stripSqlComments(
      readFileSync(join(MIGRATIONS_DIR, "..", "schema.sql"), "utf8"),
    );

    for (const file of files) {
      const { columnAdds } = parseMigration(
        readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      );
      for (const { table, column } of columnAdds) {
        // schema.sql 里这一列写在对应的 CREATE TABLE 块中
        const block = new RegExp(
          `CREATE TABLE[^;]*?\\b${table}\\b[\\s\\S]*?;`,
          "i",
        ).exec(schema);
        assert.ok(block, `schema.sql 里找不到表 ${table}`);
        assert.match(
          block[0],
          new RegExp(`\\b${column}\\b`),
          `${file} 给 ${table} 加了 ${column}，但 schema.sql 的建表语句里没有 —— ` +
            "全新部署会缺这一列",
        );
      }
    }
  });

  test("迁移建的表 schema.sql 里也有", () => {
    const schema = stripSqlComments(
      readFileSync(join(MIGRATIONS_DIR, "..", "schema.sql"), "utf8"),
    );
    for (const file of files) {
      const { idempotent } = parseMigration(
        readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      );
      for (const stmt of idempotent) {
        const table = /CREATE TABLE IF NOT EXISTS (\w+)/i.exec(stmt)?.[1];
        if (!table) continue;
        assert.match(
          schema,
          new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"),
          `${file} 建了 ${table}，但 schema.sql 里没有 —— 全新部署会缺这张表`,
        );
      }
    }
  });

  test("迁移文件不再声称自己可以整份重复执行", () => {
    // 它一度这么写，而第 2 节的 ALTER 根本做不到 —— 照着做会拿到
    // 一个分不清「已经迁过了」还是「真坏了」的报错。
    const doc = readFileSync(
      join(MIGRATIONS_DIR, "0001_open_platform.sql"),
      "utf8",
    );
    assert.doesNotMatch(doc, /跑两遍不会出错/);
    assert.match(doc, /npm run migrate/, "得告诉人正确的跑法");
  });
});
