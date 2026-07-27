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

/**
 * RFC 6750 §3 的 `WWW-Authenticate` 挑战头。
 *
 * ── 为什么要有这个 ─────────────────────────────────────────────
 *
 * RFC 6750 §3：资源服务器拒绝一个请求时，**必须**带上 `WWW-Authenticate`。
 * 它是客户端唯一能机器读取的「我该怎么认证」的信号 —— 没有它，客户端只能
 * 靠猜（或者靠人去读文档）。
 *
 * 实测（2026-07-27）线上是没有的：
 *
 *     $ curl -i https://id.nightcord.de5.net/oauth/userinfo
 *     HTTP/1.1 401 Unauthorized
 *     ...（没有 WWW-Authenticate）
 *
 * 而共享 SDK sekai-worker-kit 的 `unauthorized()` 一直是带的 ——
 * 只是本服务没有用那个 SDK。
 *
 * ── 一个容易写错的地方 ─────────────────────────────────────────
 *
 * RFC 6750 §3 明确说：**请求完全没带认证信息时，不应该带 error 码**。
 *
 *   > If the request lacks any authentication information ... the resource
 *   > server SHOULD NOT include an error code or other error information.
 *
 * 直觉上会想统一发 `error="invalid_token"`，但那是错的 ——
 * 「没给」和「给了但不对」是两件事，前者不是错误，只是还没认证。
 */

/** RFC 6750 §3 的 error 码。 */
export type BearerError = "invalid_request" | "invalid_token" | "insufficient_scope";

/**
 * RFC 6750 §3 规定 error_description 只能用一个受限字符集
 * （%x20-21 / %x23-5B / %x5D-7E，即可打印 ASCII 去掉双引号和反斜杠）。
 *
 * 本仓的描述都是写死的英文常量，理论上不会越界；这里仍然过滤一遍，
 * 免得将来有人把用户输入拼进去 —— 那会**让攻击者往响应头里注入内容**。
 */
function sanitize(text: string): string {
  return text.replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, " ").trim();
}

/**
 * 构造 `WWW-Authenticate` 的值。
 *
 * @param error 省略表示「请求完全没带凭据」—— 此时按规范不发 error 码
 * @param description 人读的说明，可省略
 * @param scope insufficient_scope 时告诉客户端需要哪些 scope
 */
export function bearerChallenge(
  error?: BearerError,
  description?: string,
  scope?: string
): string {
  const params: string[] = [];
  if (error) params.push(`error="${error}"`);
  if (error && description) params.push(`error_description="${sanitize(description)}"`);
  if (error === "insufficient_scope" && scope) params.push(`scope="${sanitize(scope)}"`);

  return params.length ? `Bearer ${params.join(", ")}` : "Bearer";
}
