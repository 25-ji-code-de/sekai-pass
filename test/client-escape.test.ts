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

/**
 * 取出源码里所有**最外层**的模板字符串，再筛出其中看起来是 HTML 的。
 *
 * 之前用「全文抓 `${...}`」扫过一版，结果把 `showError()`（内部走
 * textContent）和 `window.confirm()` 的插值也算进来了 —— 那些根本不是
 * HTML 上下文，只会逼着往白名单里堆东西，白名单一大就没人看了。
 *
 * 用「是不是 HTML」而不是「是不是赋给 innerHTML」来判断，是因为这一页
 * 有 `renderAppCard` / `renderKeyRow` 这种**返回** HTML 片段的函数 ——
 * 只盯 `innerHTML =` 会把它们整个漏掉，而它们恰恰是回显用户数据的地方。
 */
function htmlTemplates(source: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] !== '`') {
      i += 1;
      continue;
    }

    // 走到外层模板的结尾：`${` 内部的反引号不算结束
    const begin = i + 1;
    let j = begin;
    let depth = 0;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '$' && source[j + 1] === '{') {
        depth += 1;
        j += 2;
        continue;
      }
      if (ch === '}' && depth > 0) {
        depth -= 1;
        j += 1;
        continue;
      }
      if (ch === '`' && depth === 0) break;
      j += 1;
    }

    const body = source.slice(begin, j);
    if (/<[a-z][\w-]*[\s>/]/i.test(body)) out.push(body);
    i = j + 1;
  }
  return out;
}

/**
 * 取出一个模板里**真正会被渲染**的插值。
 *
 * 关键是递归：`${cond ? `<p>${escapeHtml(x)}</p>` : ''}` 这种嵌套模板，
 * 用一条平铺的正则是抓不到里层的 `escapeHtml(x)` 的 —— 外层那个 `${...}`
 * 本身就含 `${`，会被「不含大括号」的字符类直接排除掉，于是**整段嵌套内容
 * 静默消失**。扫描器漏掉的部分不会报错，只会显得一切正常。
 *
 * 所以：遇到含反引号的表达式就往里递归（外层的三元条件本身不渲染，
 * 两端才渲染），否则把它当作一个叶子插值。
 */
function leafInterpolations(tpl: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < tpl.length) {
    if (tpl[i] === '\\') {
      i += 2;
      continue;
    }
    if (tpl[i] === '$' && tpl[i + 1] === '{') {
      let j = i + 2;
      let depth = 1;
      while (j < tpl.length && depth > 0) {
        if (tpl[j] === '\\') {
          j += 2;
          continue;
        }
        if (tpl[j] === '{') depth += 1;
        else if (tpl[j] === '}') depth -= 1;
        if (depth === 0) break;
        j += 1;
      }
      const expr = tpl.slice(i + 2, j);
      if (expr.includes('`')) out.push(...leafInterpolations(expr));
      else out.push(expr.trim());
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

describe('开放平台页的转义覆盖率（静态扫描）', () => {
  const source = readFileSync(join(root, 'public/js/pages/apps.js'), 'utf8');

  /**
   * 这一页比授权页更危险：应用名、描述、回调地址、Key ID 全是**用户自己
   * 填进去的**，而整页都靠模板字符串拼 innerHTML。授权页至少只回显 query
   * string，这里回显的是持久化在库里的内容 —— 一次存进去，每次打开都触发。
   */
  const templates = htmlTemplates(source);
  const interpolations = templates.flatMap(leafInterpolations);

  /** 本文件自己拼好、内部已逐项转义的 HTML 片段，以及硬编码常量。 */
  const TRUSTED = new Set([
    'uris', // renderAppCard 里逐个 escapeHtml 过的 <li>
    "keys.map(renderKeyRow).join('')", // renderKeyRow 内部逐项转义
    'AUTH_METHOD_LABELS.none',
    'AUTH_METHOD_LABELS.private_key_jwt',
  ]);

  test('确实扫到了页面的模板 —— 扫不到会让下面的断言变成空转', () => {
    assert.ok(templates.length >= 6, `只找到 ${templates.length} 个 innerHTML 模板`);
    assert.ok(interpolations.length >= 20, `只找到 ${interpolations.length} 个插值`);
    assert.ok(
      interpolations.some((e) => e.includes('escapeHtml(a.name)')),
      '应用名的插值必须在扫描范围内',
    );
  });

  test('每个插值要么已转义，要么在可信白名单里', () => {
    const unescaped = interpolations.filter((expr) => {
      if (expr.startsWith('escapeHtml(')) return false;
      if (expr.startsWith('encodeURIComponent(')) return false;
      if (TRUSTED.has(expr)) return false;
      // 纯控制流：两端都是本文件里的字面量，会被单独匹配到
      if (/^[\w.]+\s*(===|!==|\?)/.test(expr)) return false;
      return true;
    });
    assert.deepEqual(
      unescaped,
      [],
      `以下插值既没转义也不在白名单里：${unescaped.join(', ')}`,
    );
  });

  test('非 HTML 上下文不该被扫进来', () => {
    // showError 走 textContent、confirm 是纯文本 —— 扫进来只会撑大白名单
    assert.ok(!interpolations.includes('d.message'), 'formatApiError 的结果进的是 textContent');
    assert.ok(!interpolations.includes('keyId'), 'window.confirm 是纯文本');
  });

  test('引入了共享的 escapeHtml', () => {
    assert.match(source, /import\s*\{[^}]*escapeHtml[^}]*\}\s*from\s*'\.\.\/utils\.js'/);
  });

  test('client_id / key_id 拼进 URL 前做了编码', () => {
    // client_id 是服务端生成的，但 key_id 完全由用户指定
    assert.ok(
      !/\/apps\/\$\{(?!encodeURIComponent)/.test(source),
      'client_id 必须 encodeURIComponent',
    );
    assert.match(source, /keys\/\$\{encodeURIComponent\(keyId\)\}/);
  });

  test('用户填的 Key ID 回显时被转义', () => {
    assert.match(source, /\$\{escapeHtml\(k\.key_id\)\}/);
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
