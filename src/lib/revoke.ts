/*
 * Copyright 2026 The 25-ji-code-de Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// RFC 7009 令牌撤销

import type { D1Database } from "@cloudflare/workers-types";
import { revokeRefreshToken } from "./tokens.ts";

/**
 * 撤销一个 token，两种类型都试。
 *
 * ── token_type_hint 只决定先试哪种，不决定试不试 ─────────────────
 *
 * RFC 7009 §2.1：
 *   > If the server is unable to locate the token using the given hint,
 *   > it MUST extend its search across all of its supported token types.
 *
 * 此前 `/oauth/revoke` 里是两段并列的 `if (!hint || hint === "...")`，
 * hint 一旦给定，另一段就被整个跳过：
 *
 *   带 hint=refresh_token 撤一个 access token → 什么都没删，**返回 200**
 *   带 hint=access_token  撤一个 refresh token → 什么都没删，**返回 200**
 *
 * 「登出看起来成功了，而 token 还活着」是安全操作里最坏的一种失败：
 * 没有任何信号，用户以为已经登出。refresh token 有效期 30 天。
 *
 * 之所以这段逻辑从路由里搬出来，是因为写在路由体里就只能靠读源码来验 ——
 * 而这个 bug 恰恰是「哪条分支会被执行」的问题，读源码最容易看漏。
 *
 * @returns 是否真的删掉了东西。**调用方不应该把它变成 4xx** ——
 *          RFC 7009 §2.2 要求 token 不存在时也返回 200。
 */
export async function revokeToken(
  db: D1Database,
  token: string,
  tokenTypeHint?: string | null
): Promise<boolean> {
  const tryRefresh = () => revokeRefreshToken(db, token, true);

  const tryAccess = async (): Promise<boolean> => {
    const result = await db.prepare(
      "DELETE FROM access_tokens WHERE token = ?"
    ).bind(token).run();
    /*
     * 看 changes，不看 success。
     *
     * D1 的 `success` 表示**语句执行成功**，删了 0 行也是 true ——
     * 原来的代码用它当判据，于是「撤销成功」这个返回值恒为真。
     */
    return ((result as any).meta?.changes ?? 0) > 0;
  };

  // hint 只影响顺序：先试它说的那种，失败了再试另一种
  const order = tokenTypeHint === "access_token"
    ? [tryAccess, tryRefresh]
    : [tryRefresh, tryAccess];

  for (const attempt of order) {
    if (await attempt()) return true;
  }
  return false;
}
