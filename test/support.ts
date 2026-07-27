/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 测试用的小工具。**这个文件不是测试**（不匹配 `test/*.test.ts`），
 * 它自己的测试在 `test/support.test.ts`。
 */

/**
 * 剥掉 JS/TS 的注释，**但不碰字符串里的内容**。
 *
 * ── 为什么不能用一行正则 ────────────────────────────────────────
 *
 * 常见写法是「一个块注释正则 + 一个行注释正则」，两条 replace 串起来。
 *
 * （这里**不能**把那两条正则原样抄进注释：行注释那条以 `[^\n]` 加星号加
 *   斜杠结尾，那两个字符连在一起就会把这段块注释提前关掉。
 *   我第一版就是这么写的，整个文件直接语法错误 ——
 *   正好是本文件要讲的那类坑的另一个变种。）
 *
 * 它会把**字符串里的斜杠加星号当成注释开头**。而 src/index.ts 里正好有三处：
 *
 *     app.use("/api/*", cors({ ... }))
 *     app.use("/oauth/*", ...)
 *     app.use("/.well-known/*", ...)
 *
 * 于是从 `"/api/*"` 开始一路吃到下一个 `*​/` —— 中间整段路由注册全没了。
 *
 * 这不是假想：`discovery-consistency.test.ts` 一开始就是那么写的，
 * 而且**碰巧是绿的**。直到我在文件末尾加了一段块注释，`*​/` 的配对位置一变，
 * 两条断言立刻报「找不到路由」。**一个靠配对位置巧合成立的检查。**
 *
 * 同理 `//` 也不能一刀切：`https://example.com` 里的 `//` 在字符串里。
 *
 * 所以这里老老实实扫一遍，跟踪三种字符串（'、"、`）和转义。
 * 保留换行，让剥完之后的行号仍然对得上。
 */
export function stripJsComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // 块注释
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end === -1 ? n : end + 2);
      // 换行原样保留，行号不变
      out += body.replace(/[^\n]/g, '');
      i = end === -1 ? n : end + 2;
      continue;
    }

    // 行注释
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // 字符串 / 模板字面量：原样抄过去，注意转义
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }

  return out;
}
