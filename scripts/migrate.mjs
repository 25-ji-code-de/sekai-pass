/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 幂等地应用 migrations/ 下的迁移。
 *
 * ── 为什么需要这个脚本 ────────────────────────────────────────────
 *
 * SQLite（因而 D1）没有 `ADD COLUMN IF NOT EXISTS`。所以一份含 ALTER TABLE
 * 的 .sql 文件**只能干净地跑一次**：第二次会在第一条 ALTER 上以
 * `duplicate column name` 中止，后面的语句一条都不会执行。
 *
 * 这在两种很常见的情况下会咬人：
 *
 *   1. 不确定线上库当前是什么状态，想「再跑一遍确认一下」—— 结果拿到一个
 *      看起来很吓人的报错，而且分不清是「已经迁移过了」还是「真的坏了」。
 *   2. 迁移跑到一半失败（网络断了、权限不够），库里多了几列少了几列。
 *      这时候重跑必然报错，只能手工比对 schema 补齐 —— 最危险的操作方式。
 *
 * 这个脚本先读 `pragma_table_info` 看哪几列已经在了，只补缺的那几列。
 * 跑一次、跑十次、从任意中断点接着跑，结果都一样。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *
 *   npm run migrate              # 本地库（.wrangler/state）
 *   npm run migrate -- --remote  # 线上库
 *
 * ── 单一事实来源 ──────────────────────────────────────────────────
 *
 * 要加的列**不在这个脚本里**，而是从 migrations/*.sql 里解析出来的。
 * 加新列时只改 .sql，这里不用动 —— 免得两处不一致。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'sekai_pass_db';

// ── 纯逻辑（可测）─────────────────────────────────────────────────

/**
 * 去掉 `--` 行注释。
 *
 * 注意：不认字符串字面量里的 `--`。迁移文件里没有这种东西，
 * 真要写的话请避开 —— 与其在这里塞一个半吊子 SQL 词法分析器，
 * 不如把这条限制写明白。
 */
export function stripSqlComments(sql) {
  return sql
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('--');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/** `ALTER TABLE <表> ADD COLUMN <列> …` —— 只认这一种非幂等语句。 */
const ADD_COLUMN_RE =
  /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\b/i;

/**
 * 把一份迁移拆成「可重复执行的」与「加列」两部分。
 *
 * 其余语句（CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）本身
 * 就是幂等的，原样执行即可。
 */
export function parseMigration(sqlText) {
  const idempotent = [];
  const columnAdds = [];

  for (const raw of stripSqlComments(sqlText).split(';')) {
    const stmt = raw.trim();
    if (!stmt) continue;

    const m = ADD_COLUMN_RE.exec(stmt);
    if (m) columnAdds.push({ table: m[1], column: m[2], sql: stmt });
    else idempotent.push(stmt);
  }

  return { idempotent, columnAdds };
}

/**
 * 给定表里**已有**的列，挑出还需要执行的加列语句。
 *
 * @param {{table: string, column: string, sql: string}[]} columnAdds
 * @param {Map<string, Set<string>>} existing 表名 -> 已有列名
 */
export function planColumnAdds(columnAdds, existing) {
  return columnAdds.filter(
    (add) => !existing.get(add.table)?.has(add.column),
  );
}

// ── 与 wrangler 打交道 ────────────────────────────────────────────

function wrangler(args) {
  const res = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    const detail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
    throw new Error(`wrangler ${args.join(' ')} 失败：\n${detail}`);
  }
  return res.stdout ?? '';
}

/** wrangler 会在 JSON 前面打一段横幅，从第一个 `[` 开始取。 */
function parseWranglerJson(out) {
  const at = out.indexOf('[');
  if (at === -1) throw new Error(`wrangler 没有输出 JSON：\n${out}`);
  return JSON.parse(out.slice(at));
}

function query(target, sql) {
  const out = wrangler([
    'd1', 'execute', DB_NAME, target, '--yes', '--json', '--command', sql,
  ]);
  return parseWranglerJson(out)[0]?.results ?? [];
}

function exec(target, sql) {
  wrangler(['d1', 'execute', DB_NAME, target, '--yes', '--command', sql]);
}

function columnsOf(target, table) {
  // 表还不存在时 pragma_table_info 返回空集，正好也是我们要的语义。
  const rows = query(target, `SELECT name FROM pragma_table_info('${table}')`);
  return new Set(rows.map((r) => r.name));
}

// ── 主流程 ────────────────────────────────────────────────────────

async function main() {
  const target = process.argv.includes('--remote') ? '--remote' : '--local';
  console.log(`目标库：${DB_NAME} ${target}\n`);

  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { idempotent, columnAdds } = parseMigration(
      readFileSync(join(dir, file), 'utf8'),
    );
    console.log(`── ${file} ──`);

    for (const stmt of idempotent) exec(target, stmt);
    if (idempotent.length) console.log(`  ${idempotent.length} 条可重复语句已执行`);

    // 每张表只查一次
    const existing = new Map();
    for (const { table } of columnAdds) {
      if (!existing.has(table)) existing.set(table, columnsOf(target, table));
    }

    const todo = planColumnAdds(columnAdds, existing);
    const skipped = columnAdds.length - todo.length;
    for (const add of todo) {
      exec(target, add.sql);
      console.log(`  + ${add.table}.${add.column}`);
    }
    if (skipped) console.log(`  ${skipped} 列已存在，跳过`);
    console.log();
  }

  // ── 存量应用提示 ────────────────────────────────────────────────
  //
  // 认领这一步故意不自动做：把线上跑着的应用划给某个账号是需要人确认的决定。
  // 但「它们在开放平台里看不见」这件事必须让人知道，否则会以为是 bug。
  const orphans = query(
    target,
    'SELECT client_id FROM applications WHERE owner_user_id IS NULL',
  );
  if (orphans.length) {
    console.log(`注意：${orphans.length} 个存量应用没有 owner，在开放平台里看不见：`);
    for (const o of orphans) console.log(`  ${o.client_id}`);
    console.log(
      '\n认领（把 <你的 user id> 换成实际值，可用 ' +
        "SELECT id, username FROM users 查）：\n" +
        "  UPDATE applications SET owner_user_id = '<你的 user id>' " +
        'WHERE owner_user_id IS NULL',
    );
  } else {
    console.log('所有应用都有 owner。');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
