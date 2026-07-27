/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `examples/` 里的接入示例不得把 claim 原样拼进 HTML。
 *
 * ── 为什么这件事比它看起来严重 ──────────────────────────────────
 *
 * 示例存在的意义就是**被抄**。`oidc-client-nodejs.js` 与 `oidc-demo.html`
 * 此前一处转义都没有，把 ID Token 的 claim 直接拼进 HTML：
 *
 *     <div class="info-value">${req.session.user.name}</div>
 *     <span class="claim-value">${displayValue}</span>
 *     statusDiv.innerHTML = `<div class="status ${type}">${message}</div>`
 *
 * `name` / `preferred_username` / `email` 归根到底是**别的用户自己填的**。
 * SEKAI Pass 上昵称只校验长度（`validateDisplayName`，≤ 50 字符），
 * `<img src=x onerror=alert(1)>` 是 33 个字符，存得下。
 *
 * 于是：任何人把昵称改成一段脚本，登录照抄示例搭起来的应用，脚本就在
 * **那个应用的**域上执行。Pass 自己的授权页是转义了的（`src/lib/html.ts`），
 * 照抄示例的人却没有 —— 我们等于在教人写 XSS。
 *
 * `showStatus` 那条还更直接：授权失败那一路传进去的是**回调 URL 上的
 * `error` 查询参数**，攻击者构造一个链接就能控制。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXAMPLES = join(import.meta.dirname, "..", "examples");

/** 认可的转义/净化调用。 */
const ESCAPERS = [
  "escapeHtml(",
  "encodeURIComponent(",
  "DOMPurify.sanitize(",
];

/** 显然安全的表达式形状。 */
const SAFE_EXPR = [
  /^[A-Z_][A-Z0-9_]*$/, // 全大写常量
  /^\d+$/,
  /^['"][^'"]*['"]$/, // 字符串字面量
  // 三元的两个分支都是字面量：`x ? '✅ 是' : '❌ 否'`
  /^[^?]*\?\s*'[^']*'\s*:\s*'[^']*'$/,
];

/**
 * 取出一段源码里的模板字面量及其插值。
 *
 * 逐字符扫，能正确处理嵌套花括号与嵌套模板 —— 用正则做这件事会在
 * `${a ? `<b>${c}</b>` : ''}` 这种地方断掉，而示例里到处都是这种写法。
 */
function templates(src: string): Array<{ body: string; interps: Array<{ expr: string; at: number }>; start: number }> {
  const out: Array<{ body: string; interps: Array<{ expr: string; at: number }>; start: number }> = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "`" || (i > 0 && src[i - 1] === "\\")) continue;
    let j = i + 1;
    const interps: Array<{ expr: string; at: number }> = [];
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "`") break;
      if (src[j] === "$" && src[j + 1] === "{") {
        let d = 1;
        let k = j + 2;
        while (k < src.length && d > 0) {
          if (src[k] === "{") d++;
          else if (src[k] === "}") d--;
          if (d === 0) break;
          k++;
        }
        interps.push({ expr: src.slice(j + 2, k).replace(/\s+/g, " ").trim(), at: j });
        j = k + 1;
        continue;
      }
      j++;
    }
    out.push({ body: src.slice(i + 1, j), interps, start: i });
    i = j;
  }
  return out;
}

/**
 * 这处插值是不是安全的。
 *
 * 表达式里嵌了模板字面量时（`${cond ? `<b>${x}</b>` : ''}`），外层只是在
 * **选分支**，真正输出的是内层那些插值 —— 所以递归下去看内层，
 * 而不是拿整个三元去匹配。示例里到处都是这种写法。
 */
function isSafe(expr: string): boolean {
  if (!expr) return true;
  if (SAFE_EXPR.some((re) => re.test(expr))) return true;

  if (expr.includes("`")) {
    const inner = templates(expr).flatMap((t) => t.interps);
    // 嵌套模板里一个插值都没有 = 纯静态片段，安全
    return inner.every((it) => isSafe(it.expr));
  }

  return ESCAPERS.some((e) => expr.includes(e));
}

const FILES = readdirSync(EXAMPLES).filter((f) => /\.(js|ts|html)$/.test(f));

describe("examples/ 里不得把值原样拼进 HTML", () => {
  test("目录里有示例文件（否则下面几条是空跑）", () => {
    assert.ok(FILES.length >= 3, `只找到 ${FILES.length} 个示例文件`);
  });

  for (const file of FILES) {
    test(file, () => {
      const src = readFileSync(join(EXAMPLES, file), "utf8");
      const bad: string[] = [];

      for (const t of templates(src)) {
        // 只看确实在拼 HTML 的模板
        if (!/<[a-zA-Z/]/.test(t.body)) continue;
        for (const it of t.interps) {
          if (isSafe(it.expr)) continue;
          // it.at 已经是相对整份源码的偏移，不要再加 t.start
          const line = src.slice(0, it.at).split("\n").length;
          bad.push(`第 ${line} 行：\${${it.expr.slice(0, 80)}}`);
        }
      }

      assert.deepEqual(
        bad,
        [],
        `${file} 把这些值原样拼进了 HTML —— 示例是给人抄的，抄走的就是 XSS：\n  ` +
          bad.join("\n  "),
      );
    });
  }

  test("扫描器确实在工作（不是空跑）", () => {
    /*
     * 这一条防的是：模板解析写错了、或者过滤条件太宽，导致上面几条
     * 「没有发现问题」其实是「一个插值都没扫到」。
     */
    let htmlTemplates = 0;
    let interps = 0;
    for (const file of FILES) {
      const src = readFileSync(join(EXAMPLES, file), "utf8");
      for (const t of templates(src)) {
        if (!/<[a-zA-Z/]/.test(t.body)) continue;
        htmlTemplates++;
        interps += t.interps.length;
      }
    }
    assert.ok(htmlTemplates >= 2, `只扫到 ${htmlTemplates} 个 HTML 模板`);
    assert.ok(interps >= 15, `只扫到 ${interps} 处插值`);
  });

  test("已知的坏样本会被判为不安全（判据本身有效）", () => {
    for (const bad of [
      "req.session.user.name",
      "displayValue",
      "message",
      "user.email",
    ]) {
      assert.equal(isSafe(bad), false, `${bad} 本该被判为不安全`);
    }
    for (const good of [
      "escapeHtml(req.session.user.name)",
      "'✅ 是'",
      "CONFIG",
      "x ? '✅ 是' : '❌ 否'",
    ]) {
      assert.equal(isSafe(good), true, `${good} 本该被判为安全`);
    }
  });
});

describe("Node 示例自带转义函数", () => {
  const src = readFileSync(join(EXAMPLES, "oidc-client-nodejs.js"), "utf8");

  test("有 escapeHtml，且五个字符都覆盖", () => {
    const fn = /function escapeHtml[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    assert.ok(fn, "找不到 escapeHtml");
    for (const [ch, ent] of [
      ["&", "&amp;"],
      ["<", "&lt;"],
      [">", "&gt;"],
      ['"', "&quot;"],
      ["'", "&#39;"],
    ]) {
      assert.ok(fn.includes(ent), `escapeHtml 没有处理 ${ch}`);
    }
  });

  test("`&` 最先替换（否则实体会被二次转义）", () => {
    const fn = /function escapeHtml[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    const order = [...fn.matchAll(/replace\(\/(.)\/g/g)].map((m) => m[1]);
    assert.equal(order[0], "&", `替换顺序是 ${order.join(" ")}，& 必须最先`);
  });
});
