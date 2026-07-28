/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 安全响应头的测试。
 *
 * 在加上这些之前，**整个 SSO 一个安全头都没有** —— 授权同意页可以被
 * iframe 嵌套，攻击者透明覆盖后诱导用户点「允许访问」即可完成授权。
 *
 * 这里用静态扫描而不是起 Worker：本仓的入口依赖 D1 / KV binding，
 * 单测里跑不起来。扫描的是「中间件确实注册了这些头、且取值正确」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/index.ts'), 'utf8');

/** 取出 `c.header("X", "Y")` 里的值。 */
function headerValue(name: string): string | null {
  const m = source.match(new RegExp(`c\\.header\\(\\s*"${name}"\\s*,\\s*([^)]+)\\)`));
  if (!m) return null;
  const raw = m[1].trim();
  // 字面量直接返回；常量名则去源码里找它的定义
  const literal = raw.match(/^"(.*)"$/);
  if (literal) return literal[1];
  const constDef = source.match(new RegExp(`const ${raw} = \\[([\\s\\S]*?)\\]\\.join`));
  if (!constDef) return raw;
  return [...constDef[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).join('; ');
}

describe('中间件注册', () => {
  test('对所有路径生效', () => {
    assert.match(source, /app\.use\("\*",\s*async \(c, next\) => \{/);
  });

  test('在 next() 之后设置头 —— 否则会被 handler 的响应覆盖', () => {
    const block = source.match(/app\.use\("\*"[\s\S]*?\n\}\);/)?.[0] ?? '';
    const awaitIdx = block.indexOf('await next()');
    const headerIdx = block.indexOf('c.header(');
    assert.ok(awaitIdx >= 0, '应先 await next()');
    assert.ok(headerIdx > awaitIdx, 'c.header 必须在 await next() 之后');
  });
});

describe('点击劫持防护', () => {
  test('X-Frame-Options: DENY', () => {
    // 同意页一个误点就等于批准授权，绝不能允许被嵌套
    assert.equal(headerValue('X-Frame-Options'), 'DENY');
  });

  test('CSP 里同时有 frame-ancestors none（现代浏览器优先看它）', () => {
    assert.match(headerValue('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
  });
});

describe('其它基础安全头', () => {
  test('X-Content-Type-Options: nosniff', () => {
    assert.equal(headerValue('X-Content-Type-Options'), 'nosniff');
  });

  test('Referrer-Policy 不泄漏完整 URL', () => {
    const value = headerValue('Referrer-Policy') ?? '';
    assert.ok(
      ['strict-origin-when-cross-origin', 'no-referrer', 'same-origin'].includes(value),
      `Referrer-Policy 取值过宽：${value}`,
    );
  });

  test('HSTS 至少一年', () => {
    const value = headerValue('Strict-Transport-Security') ?? '';
    const m = value.match(/max-age=(\d+)/);
    assert.ok(m, '应设置 max-age');
    assert.ok(Number(m![1]) >= 31536000, 'max-age 应不少于一年');
  });

  test('HSTS 不带 includeSubDomains —— 避免影响其它子域', () => {
    assert.ok(!(headerValue('Strict-Transport-Security') ?? '').includes('includeSubDomains'));
  });
});

describe('CSP —— 强制生效的部分', () => {
  const csp = headerValue('Content-Security-Policy') ?? '';

  test('零风险指令齐全', () => {
    for (const directive of [
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(csp.includes(directive), `缺少 ${directive}`);
    }
  });

  test('不含 form-action —— 它会拦掉 OAuth 授权页 POST 后的跨域 302 跳转', () => {
    /*
     * 浏览器把表单提交后的重定向也拿去和 form-action 比对。授权页 POST 到
     * /oauth/authorize，服务端 302 跳到第三方 redirect_uri —— form-action
     * 'self'（甚至 'none'）会静默拦掉这一跳，用户点了「允许」却不跳转。
     *
     * redirect_uri 的安全性由服务端在 GET/POST 两阶段与注册值比对来保证，
     * 不依赖 CSP。所以这里不设 form-action，而不是设成某个值。
     */
    assert.ok(!csp.includes('form-action'), 'CSP_ENFORCED 不应包含 form-action');
  });

  test('强制生效的部分不含 default-src —— 那会立刻拦掉资源', () => {
    assert.ok(!csp.includes('default-src'), '完整策略应留在 Report-Only 阶段');
  });
});

describe('CSP —— Report-Only 的完整策略', () => {
  const csp = headerValue('Content-Security-Policy-Report-Only') ?? '';

  test('有 default-src self 兜底', () => {
    assert.ok(csp.includes("default-src 'self'"));
  });

  test('放行 Turnstile 的脚本与挑战 iframe', () => {
    assert.ok(csp.includes('script-src') && csp.includes('https://challenges.cloudflare.com'));
    assert.match(csp, /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
  });

  test('script-src 不含 unsafe-inline —— index.html 没有内联脚本', () => {
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'SPA 入口无内联脚本，不该放宽');
    assert.ok(!scriptSrc.includes("'unsafe-eval'"));
  });

  test('放行头像所在的对象存储', () => {
    for (const host of [
      'https://assets.nightcord.de5.net',
      'https://storage.nightcord.de5.net',
      'https://r2.nightcord.de5.net',
    ]) {
      assert.ok(csp.includes(host), `img-src 缺少 ${host}`);
    }
  });

  test('指令名全部合法', () => {
    const KNOWN = new Set([
      'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src',
      'connect-src', 'object-src', 'frame-src', 'worker-src', 'manifest-src',
      'base-uri', 'form-action', 'frame-ancestors', 'report-uri', 'report-to',
    ]);
    for (const directive of csp.split(';').map((s) => s.trim()).filter(Boolean)) {
      const name = directive.split(/\s+/)[0];
      assert.ok(KNOWN.has(name), `未知指令 ${name}`);
    }
  });

  test('没有重复指令', () => {
    const names = csp.split(';').map((d) => d.trim().split(/\s+/)[0]).filter(Boolean);
    const dupes = names.filter((x, i) => names.indexOf(x) !== i);
    assert.deepEqual([...new Set(dupes)], []);
  });
});
