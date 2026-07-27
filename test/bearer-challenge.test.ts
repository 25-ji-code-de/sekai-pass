/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 401 必须告诉客户端「该怎么认证」。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * RFC 6750 §3：资源服务器拒绝请求时**必须**带 `WWW-Authenticate`。
 * 它是客户端唯一能机器读取的认证提示 —— 没有它，客户端只能靠猜。
 *
 * 实测（2026-07-27）线上没有：
 *
 *     $ curl -i https://id.nightcord.de5.net/oauth/userinfo
 *     HTTP/1.1 401 Unauthorized
 *     Content-Type: application/json
 *     ...（整份响应里没有 WWW-Authenticate）
 *
 * 全仓 20 处 401，一处都没发过这个头。
 * 而共享 SDK sekai-worker-kit 的 `unauthorized()` 一直是带的 ——
 * 只是本服务没用那个 SDK。**同一个概念的两份实现，一份对一份不对。**
 *
 * ── 哪些 401 该发，哪些不该 ─────────────────────────────────────
 *
 * 只有 **Bearer 保护的资源**适用 RFC 6750：
 *
 *   适用   /oauth/userinfo、requireScopes 中间件
 *   不适用 src/lib/api.ts 里那 15 处 —— 它们是 **session cookie** 认证
 *          （`c.get("user")`），发 `WWW-Authenticate: Bearer` 是错的，
 *          等于告诉浏览器去准备一个它根本不该用的凭据
 *
 * 这个区分是这批测试里最容易被后人推翻的一条，所以单独钉住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { bearerChallenge } from '../src/lib/bearer-challenge.ts';
import { stripJsComments } from './support.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('bearerChallenge 的构造', () => {
  test('完全没带凭据时不发 error 码', () => {
    /*
     * RFC 6750 §3 明确要求：
     *   > If the request lacks any authentication information ... the resource
     *   > server SHOULD NOT include an error code or other error information.
     *
     * 直觉上会想统一发 invalid_token，但「没给」和「给了但不对」是两件事。
     */
    assert.equal(bearerChallenge(), 'Bearer');
  });

  test('token 无效时发 invalid_token', () => {
    assert.equal(
      bearerChallenge('invalid_token', 'The access token is invalid or expired'),
      'Bearer error="invalid_token", error_description="The access token is invalid or expired"',
    );
  });

  test('scope 不足时带上需要的 scope', () => {
    assert.equal(
      bearerChallenge('insufficient_scope', 'need more', 'profile email'),
      'Bearer error="insufficient_scope", error_description="need more", scope="profile email"',
    );
  });

  test('scope 参数只对 insufficient_scope 生效', () => {
    // 别的 error 码带 scope 没有意义，RFC 6750 §3 也只在那一种下定义了它
    assert.equal(
      bearerChallenge('invalid_token', 'x', 'profile'),
      'Bearer error="invalid_token", error_description="x"',
    );
  });

  test('没有 error 码时也不发 error_description', () => {
    assert.equal(bearerChallenge(undefined, '这句不该出现'), 'Bearer');
  });
});

describe('构造出来的头不会被注入', () => {
  /*
   * 现在所有描述都是写死的英文常量，越不了界。这几条防的是**将来**：
   * 有人把用户输入拼进 error_description，就等于让攻击者往响应头里写东西。
   * RFC 6750 §3 给 error_description 规定的字符集正是为了这个。
   */
  test('双引号被剔掉，不能提前闭合参数', () => {
    const v = bearerChallenge('invalid_token', 'a"b');
    assert.ok(!v.includes('a"b'), '双引号原样进了头里');
    assert.equal(v.split('"').length - 1, 4, '引号数量对不上，说明多出了一对');
  });

  test('反斜杠被剔掉', () => {
    assert.ok(!bearerChallenge('invalid_token', 'a\\b').includes('\\'));
  });

  test('换行与回车被剔掉 —— 否则可以塞进整个额外的响应头', () => {
    const v = bearerChallenge('invalid_token', 'a\r\nX-Injected: 1');
    assert.ok(!/[\r\n]/.test(v), '响应头值里含换行 = 响应拆分');
  });

  test('非 ASCII 被替换掉', () => {
    const v = bearerChallenge('invalid_token', '过期了');
    assert.ok(/^[\x20-\x7E]*$/.test(v), '头值里有非 ASCII 字符');
  });
});

describe('该发的地方都发了', () => {
  const index = stripJsComments(read('src/index.ts'));
  const scope = stripJsComments(read('src/lib/scope.ts'));

  test('userinfo 的每一条 401 都配了挑战头', () => {
    const handler = /app\.get\("\/oauth\/userinfo"[\s\S]*?\n\}\);/.exec(index)?.[0] ?? '';
    assert.ok(handler, '找不到 /oauth/userinfo 处理器');

    const four01 = (handler.match(/, 401\)/g) ?? []).length;
    const challenges = (handler.match(/WWW-Authenticate/g) ?? []).length;
    assert.ok(four01 > 0, 'userinfo 里一条 401 都没有？正则多半写错了');
    assert.equal(
      challenges,
      four01,
      `userinfo 里有 ${four01} 条 401，但只有 ${challenges} 处 WWW-Authenticate`,
    );
  });

  test('requireScopes 的每一条拒绝都配了挑战头', () => {
    const mw = /export function requireScopes[\s\S]*?\n\}/.exec(scope)?.[0] ?? '';
    assert.ok(mw, '找不到 requireScopes');

    const rejects = (mw.match(/, 40[13]\)/g) ?? []).length;
    const challenges = (mw.match(/WWW-Authenticate/g) ?? []).length;
    assert.equal(rejects, 3, 'requireScopes 的拒绝分支数变了，去确认下面这条还成立');
    assert.equal(challenges, rejects, '有拒绝分支没发挑战头');
  });

  test('浏览器读得到它 —— WWW-Authenticate 在 exposeHeaders 里', () => {
    /*
     * 这条是「发了但看不见」那类坑。跨域响应默认只暴露 CORS 安全清单里
     * 那几个头，其余被 fetch 屏蔽：服务端发了、DevTools 里看得见，
     * 但 `res.headers.get('WWW-Authenticate')` 返回 null。
     *
     * 本服务的客户端全是浏览器里的 SPA，不 expose 等于白发。
     */
    const oauthCors = /app\.use\("\/oauth\/\*", cors\(\{[\s\S]*?\}\)\);/.exec(index)?.[0] ?? '';
    assert.ok(oauthCors, '找不到 /oauth/* 的 CORS 配置');
    assert.match(
      oauthCors,
      /exposeHeaders:[^\]]*WWW-Authenticate/,
      '/oauth/* 的 CORS 没把 WWW-Authenticate 暴露出去 —— 浏览器客户端读不到',
    );
  });
});

describe('不该发的地方没发', () => {
  test('session cookie 认证的那批 401 不发 Bearer 挑战头', () => {
    /*
     * src/lib/api.ts 用的是 `c.get("user")` —— Lucia 的 session cookie，
     * 不是 Bearer。给它发 `WWW-Authenticate: Bearer` 是错的：
     * 那是在告诉客户端去准备一个这个端点根本不接受的凭据。
     *
     * 这条也是给后来人的提醒：**不要因为「统一一下」就把这里也加上。**
     */
    const api = stripJsComments(read('src/lib/api.ts'));
    assert.ok(
      api.includes('c.get("user")'),
      '前置条件变了：api.ts 不再用 session 认证，这条测试要重新想',
    );
    assert.ok(
      !api.includes('WWW-Authenticate'),
      'api.ts 是 session cookie 认证，不该发 Bearer 挑战头',
    );
  });
});
