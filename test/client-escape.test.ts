/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 客户端 escapeHtml 与授权页转义覆盖率的测试。
 *
 * 授权页有**两套实现**：服务端渲染的 src/lib/html.ts，以及客户端 SPA 的
 * public/js/pages/authorize.js。两边都把不可信值插进 HTML 模板，
 * 修其中一套很容易漏掉另一套 —— 这里用静态扫描把覆盖率钉住。
 *
 * 客户端那条路径的 scope 直接来自 query string
 * （authorize.js:53 `getQueryParams().scope`），未知 scope 会以
 * `{ label: scope }` 原样进 innerHTML。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 从 utils.js 里取出 escapeHtml 的实现来测（它是浏览器 ESM，可直接 import）。 */
const { escapeHtml } = await import('../public/js/utils.js');

describe('escapeHtml', () => {
  test('转义全部五个危险字符', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
  });

  test('& 最先替换 —— 不能二次转义', () => {
    // 写错顺序会得到 &amp;lt;
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  test('元素注入 payload 被中和', () => {
    assert.equal(
      escapeHtml('<script>alert(1)</script>'),
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  test('属性闭合 payload 被中和', () => {
    const out = escapeHtml('" autofocus onfocus="alert(1)');
    assert.ok(!out.includes('"'), '不得残留原始双引号');
    assert.ok(out.includes('&quot;'));
  });

  test('单引号也转义 —— 不能依赖模板只用双引号', () => {
    const out = escapeHtml("' onmouseover='alert(1)");
    assert.ok(!out.includes("'"));
  });

  test('null / undefined 转成空串，不渲染成字面量', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.ok(!escapeHtml(undefined).includes('undefined'));
  });

  test('正常文本原样保留', () => {
    assert.equal(escapeHtml('SEKAI Hub'), 'SEKAI Hub');
    assert.equal(escapeHtml('なこ 25時'), 'なこ 25時');
    assert.equal(escapeHtml(0), '0');
  });
});

describe('客户端授权页的转义覆盖率（静态扫描）', () => {
  const source = readFileSync(join(root, 'public/js/pages/authorize.js'), 'utf8');

  /** 模板字符串里所有插值。 */
  const interpolations = [...source.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());

  /**
   * 允许不转义的插值：
   *   scopeListHtml —— 本文件自己拼的、内部已逐项转义的 HTML
   *   detail.icon   —— 硬编码的 SVG 图标
   *   params.toString() —— 用在 navigate() 的 URL 里，不是 innerHTML
   */
  const TRUSTED = new Set(['scopeListHtml', 'detail.icon', 'params.toString()']);

  test('每个插值要么已转义，要么在可信白名单里', () => {
    const unescaped = interpolations.filter(
      (expr) => !expr.startsWith('escapeHtml(') && !expr.startsWith('encodeURIComponent(') && !TRUSTED.has(expr),
    );
    assert.deepEqual(
      unescaped,
      [],
      `以下插值既没转义也不在白名单里：${unescaped.join(', ')}`,
    );
  });

  test('引入了共享的 escapeHtml', () => {
    assert.match(source, /import\s*\{[^}]*escapeHtml[^}]*\}\s*from\s*'\.\.\/utils\.js'/);
  });

  test('client_id 拼进 URL 前做了编码', () => {
    // 不编码的话 query string 里的 & 能注入额外参数
    assert.match(source, /client_id=\$\{encodeURIComponent\(client_id\)\}/);
  });

  test('scope 来自 query string —— 这是反射型 XSS 的入口，必须转义', () => {
    assert.match(source, /getQueryParams\(\)\.scope/, '确认入口仍然存在');
    assert.match(source, /\$\{escapeHtml\(scope\)\}/, 'scope 必须转义');
    assert.match(source, /\$\{escapeHtml\(detail\.label\)\}/, '未知 scope 会成为 label');
  });
});

describe('服务端授权页的转义覆盖率（静态扫描）', () => {
  const source = readFileSync(join(root, 'src/lib/html.ts'), 'utf8');
  const interpolations = [...source.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());

  /** 与客户端同理：这些是可信 HTML 或纯控制流。 */
  const TRUSTED = new Set(['content', 'scopeListHtml', 'detail.icon']);

  test('每个插值要么已转义，要么在可信白名单里', () => {
    const unescaped = interpolations.filter((expr) => {
      if (expr.startsWith('escapeHtml(')) return false;
      if (TRUSTED.has(expr)) return false;
      // 三元控制流：`app.state ? \`…\` : ''` —— 内部的插值会被单独匹配到
      if (/^\w[\w.]*\s*\?/.test(expr)) return false;
      return true;
    });
    assert.deepEqual(
      unescaped,
      [],
      `以下插值既没转义也不在白名单里：${unescaped.join(', ')}`,
    );
  });
});

describe('没有遗留的本地 escapeHtml 副本', () => {
  test('dashboard.js 改用共享实现', () => {
    const source = readFileSync(join(root, 'public/js/pages/dashboard.js'), 'utf8');
    assert.ok(
      !/const\s+escapeHtml\s*=/.test(source),
      '本地副本漏了单引号，应该用 utils.js 的共享实现',
    );
    assert.match(source, /import\s*\{[^}]*escapeHtml[^}]*\}\s*from\s*'\.\.\/utils\.js'/);
  });
});
