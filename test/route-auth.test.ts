/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 每一条路由要么鉴权，要么在明确的公开清单里。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────
 *
 * 这是授权服务器 —— 一条路由忘了鉴权，后果是任何人都能读或改别人的东西，
 * 而且**不会有任何报错**。开放平台（`/apps`、`/apps/:id/keys`）之后
 * 路由还会继续加，靠人记得住不是办法。
 *
 * 这批测试是把一次人工审计固化下来：当时逐条核过 29 条路由，
 * 结论是「全部正确」。固化的意义不在于那次结论，而在于**下一条新路由**。
 *
 * ── 判据 ────────────────────────────────────────────────────────
 *
 * 「鉴权」指 handler 里出现下列之一：
 *   - `requireUser(c)`      —— 开放平台那批用的
 *   - `c.get("user")`       —— 旧的那批用的
 *   - `Authorization` 头 + token 校验  —— OAuth 端点用的（userinfo）
 *
 * 剩下的必须列在 PUBLIC 里并写明理由。清单本身也有反向检查：
 * 列了但路由已不存在的，会被指出来 —— 免得清单慢慢变成谎言。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/**
 * 明确公开的路由。**每条都要有理由** —— 加一条进来等于说
 * 「我确认任何人都可以调它」。
 */
const PUBLIC = new Map<string, string>([
  ["POST /auth/register", "注册本身就是登录前的动作；靠人机校验限流"],
  ["POST /auth/login", "登录本身就是登录前的动作；靠人机校验限流"],
  ["POST /auth/logout", "自带 token；无 token 时也没什么可做"],
  ["GET /challenge/init", "登录前的人机校验，此时还没有会话"],
  ["POST /challenge/report", "登录前的人机校验；靠 KV 里的 challengeId + IP 绑定"],
  ["GET /config", "只返回验证码 site key —— site key 本来就要放进页面"],
  ["GET /oauth/config", "只返回端点 URL，与 discovery 同性质"],
  [
    "GET /.well-known/oauth-authorization-server",
    "RFC 8414 要求公开",
  ],
  ["GET /.well-known/openid-configuration", "OIDC Discovery 要求公开"],
  ["GET /.well-known/jwks.json", "公钥，要求公开"],
  ["POST /oauth/token", "用 PKCE / private_key_jwt 认证客户端，不是会话"],
  ["POST /oauth/revoke", "RFC 7009：凭 token 本身认证"],
  ["GET *", "静态资源兜底"],
]);

/** 靠重定向到登录页而不是 401 的路由 —— 也算鉴权。 */
const REDIRECTS_TO_LOGIN = new Set([
  "GET /oauth/authorize",
  "POST /oauth/authorize",
]);

interface Route {
  key: string;
  file: string;
  line: number;
  body: string;
}

/** 从一份源码里取出所有路由及其 handler 函数体。 */
function routes(file: string): Route[] {
  const src = readFileSync(join(root, file), "utf8");
  const re =
    /(\w+Router|app)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]\s*,\s*async?\s*\(?c\)?\s*=>\s*\{/g;
  const out: Route[] = [];

  for (const m of src.matchAll(re)) {
    const [, , method, path] = m;
    let depth = 1;
    let i = m.index! + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push({
      key: `${method.toUpperCase()} ${path}`,
      file,
      line: src.slice(0, m.index).split("\n").length,
      body: src.slice(m.index! + m[0].length, i),
    });
  }
  return out;
}

const ALL = [...routes("src/lib/api.ts"), ...routes("src/index.ts")];

/** 这条 handler 有没有拦住未登录的人。 */
function isGuarded(r: Route): boolean {
  const sessionCheck =
    /requireUser\(c\)/.test(r.body) || /c\.get\(["']user["']\)/.test(r.body);
  const rejects = /401/.test(r.body) || REDIRECTS_TO_LOGIN.has(r.key);
  if (sessionCheck && rejects) return true;

  // OAuth 端点：Bearer token 校验
  return (
    /c\.req\.header\(["']Authorization["']\)/.test(r.body) &&
    /validateAccessToken\(/.test(r.body) &&
    /401/.test(r.body)
  );
}

describe("每条路由要么鉴权，要么明确公开", () => {
  test("确实扫到了路由（否则下面几条是空跑）", () => {
    assert.ok(
      ALL.length >= 25,
      `只扫到 ${ALL.length} 条路由 —— 正则多半没匹配上，这批测试将毫无意义`,
    );
  });

  test("没有既不鉴权又不在公开清单里的路由", () => {
    const orphans = ALL.filter((r) => !isGuarded(r) && !PUBLIC.has(r.key)).map(
      (r) => `${r.key}   (${r.file}:${r.line})`,
    );
    assert.deepEqual(
      orphans,
      [],
      "这些路由既没有鉴权，也不在 PUBLIC 清单里：\n  " +
        orphans.join("\n  ") +
        "\n\n如果确实该公开，把它加进 PUBLIC 并写明理由；" +
        "否则加上 requireUser(c)。",
    );
  });

  test("公开清单里没有已经不存在的路由（清单不会慢慢变成谎言）", () => {
    const keys = new Set(ALL.map((r) => r.key));
    const stale = [...PUBLIC.keys()].filter((k) => !keys.has(k));
    assert.deepEqual(stale, [], `PUBLIC 里这些路由已经不存在，删掉：${stale.join(", ")}`);
  });

  test("公开清单里的每条都有理由", () => {
    for (const [key, why] of PUBLIC) {
      assert.ok(why && why.length >= 5, `${key} 的公开理由太短或为空`);
    }
  });

  test("开放平台的每条路由都用 requireUser", () => {
    /*
     * /apps 那批是按 owner 隔离的，漏一条就意味着任何登录用户都能改
     * 别人的应用。这里不接受 c.get("user") 那种旧写法 —— 统一用
     * requireUser，读代码的人一眼能看出哪条是保护过的。
     */
    const apps = ALL.filter((r) => r.key.includes(" /apps"));
    assert.ok(apps.length >= 8, `只找到 ${apps.length} 条 /apps 路由`);
    for (const r of apps) {
      assert.match(
        r.body,
        /const user = requireUser\(c\);/,
        `${r.key} (${r.file}:${r.line}) 没有用 requireUser`,
      );
      assert.match(r.body, /return c\.json\(\{ error: "未授权" \}, 401\)/, `${r.key} 没有返回 401`);
    }
  });

  test("按 owner 隔离的路由都把 user.id 传进了数据层", () => {
    /*
     * 光有 requireUser 不够 —— 拿到 user 却不用它去过滤，
     * 就变成「任何登录用户都能改任何人的应用」。
     */
    const scoped = ALL.filter((r) => /\/apps\/:clientId/.test(r.key));
    assert.ok(scoped.length >= 6, `只找到 ${scoped.length} 条按 clientId 的路由`);
    for (const r of scoped) {
      assert.match(
        r.body,
        /user\.id/,
        `${r.key} (${r.file}:${r.line}) 没有把 user.id 传下去 —— 可能没做 owner 隔离`,
      );
    }
  });

  test("判据本身有效：已知受保护/公开的样本分类正确", () => {
    const byKey = new Map(ALL.map((r) => [r.key, r]));
    for (const key of ["GET /apps", "PUT /apps/:clientId", "GET /oauth/userinfo"]) {
      const r = byKey.get(key);
      assert.ok(r, `找不到路由 ${key}`);
      assert.equal(isGuarded(r!), true, `${key} 本该被判为受保护`);
    }
    for (const key of ["POST /auth/login", "GET /.well-known/jwks.json"]) {
      const r = byKey.get(key);
      assert.ok(r, `找不到路由 ${key}`);
      assert.equal(isGuarded(r!), false, `${key} 本该被判为未鉴权（它在公开清单里）`);
    }
  });
});
