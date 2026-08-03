/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 授权页 HTML 转义的测试。
 *
 * authorizePage 渲染的是 **OAuth 同意页** —— 用户在这里批准第三方应用
 * 访问自己的账号。这个页面上执行任意脚本意味着：攻击者可以自动提交同意
 * 表单、读走 authorization code，或者在真实的 SSO 域名下伪造登录框。
 *
 * 其中 state / nonce / code_challenge 直接来自 /oauth/authorize 的
 * query string（src/index.ts:229-231），完全由请求方控制，
 * 且在进入模板前**没有任何格式校验**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderPage, authorizePage } from '../src/lib/html.ts';

const baseApp = {
  name: 'SEKAI Hub',
  client_id: 'sekai_hub_client',
  redirect_uri: 'https://hub.nightcord.de5.net/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  state: 'abc123',
  scope: 'openid profile',
  nonce: 'n-0S6_WzA2Mj',
};

const baseUser = { username: 'nako', email: 'nako@example.com' };

/** 属性注入 payload：闭合 value="" 后挂事件处理器。 */
const ATTR_BREAK = '" autofocus onfocus="alert(1)';
/** 元素注入 payload。 */
const TAG_BREAK = '<script>alert(1)</script>';

/** 与 src/lib/html.ts 的 escapeHtml 保持一致。 */
function escaped(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 断言 payload 只以**转义后**的形态出现。
 *
 * 注意不能简单断言 "输出里不含 onfocus" —— 转义之后这些字符仍然作为
 * 惰性文本存在，那是安全的。真正的安全性质是：用户输入不得往输出里
 * 引入原始的 `<` / `>` / `"`，也就是原样 payload 一定不出现。
 */
function assertNoInjection(html: string, label: string, payload: string) {
  assert.ok(!html.includes(payload), `${label}: 原样 payload 出现在输出里 —— 未转义`);
  assert.ok(html.includes(escaped(payload)), `${label}: 应以转义形态保留，而不是被丢弃`);
}

describe('renderPage', () => {
  test('title 被转义', () => {
    const html = renderPage(TAG_BREAK, '<p>ok</p>');
    assertNoInjection(html, 'title', TAG_BREAK);
    assert.ok(html.includes('&lt;script&gt;'), 'title 应被 HTML 转义');
  });

  test('content 是可信 HTML，**不**转义', () => {
    // 调用方传进来的是自己拼好的模板，转义它会把整个页面变成纯文本
    const html = renderPage('标题', '<p class="x">内容</p>');
    assert.ok(html.includes('<p class="x">内容</p>'));
  });
});

describe('authorizePage —— 属性上下文注入', () => {
  // 这几个字段直接来自 query string，是最容易被利用的
  for (const field of ['state', 'nonce', 'code_challenge', 'code_challenge_method'] as const) {
    test(`${field} 里的属性闭合 payload 必须被转义`, () => {
      const html = authorizePage({ ...baseApp, [field]: ATTR_BREAK }, baseUser);
      assertNoInjection(html, field, ATTR_BREAK);
    });
  }

  test('client_id 与 redirect_uri 里的 payload 必须被转义', () => {
    for (const field of ['client_id', 'redirect_uri'] as const) {
      const html = authorizePage({ ...baseApp, [field]: ATTR_BREAK }, baseUser);
      assertNoInjection(html, field, ATTR_BREAK);
    }
  });

  test('avatar_url 里的属性闭合 payload 必须被转义', () => {
    const html = authorizePage(baseApp, { ...baseUser, avatar_url: ATTR_BREAK });
    assertNoInjection(html, 'avatar_url', ATTR_BREAK);
  });

  test('转义后原值仍以实体形式保留（不能直接丢弃）', () => {
    const html = authorizePage({ ...baseApp, state: 'a"b' }, baseUser);
    assert.ok(html.includes('&quot;'), '双引号应转义成实体而不是被删掉');
    assert.ok(html.includes('name="state"'), '字段本身应仍然渲染');
  });
});

describe('authorizePage —— 元素上下文注入', () => {
  test('app.name 里的 <script> 必须被转义', () => {
    const html = authorizePage({ ...baseApp, name: TAG_BREAK }, baseUser);
    assertNoInjection(html, 'app.name', TAG_BREAK);
  });

  test('user.username 里的 <script> 必须被转义', () => {
    const html = authorizePage(baseApp, { ...baseUser, username: TAG_BREAK });
    assertNoInjection(html, 'user.username', TAG_BREAK);
  });

  test('app.scope 里的 payload 必须被转义（同时出现在标签与 value 里）', () => {
    const html = authorizePage({ ...baseApp, scope: TAG_BREAK }, baseUser);
    assertNoInjection(html, 'app.scope', TAG_BREAK);
  });

  test('首字母缩写也要转义', () => {
    // initial 取 app.name 的首字符；"<" 开头的名字会把它带进 HTML
    const payload = '<img src=x onerror=alert(1)>';
    const html = authorizePage({ ...baseApp, name: payload }, baseUser);
    assertNoInjection(html, 'initial/name', payload);
  });
});

describe('authorizePage —— 正常渲染不被破坏', () => {
  test('合法输入下页面内容正确', () => {
    const html = authorizePage(baseApp, baseUser);
    assert.ok(html.includes('SEKAI Hub'), '应用名应显示');
    assert.ok(html.includes('nako'), '用户名应显示');
    assert.ok(html.includes('value="sekai_hub_client"'));
    assert.ok(html.includes('value="abc123"'), 'state 应回填');
    assert.ok(html.includes('hub.nightcord.de5.net'), 'redirect 主机名应显示');
  });

  test('有头像 URL 时授权页提供头像挂载点', () => {
    const html = authorizePage(baseApp, {
      ...baseUser,
      avatar_url: 'https://assets.nightcord.de5.net/avatars/nako.webp',
    });
    assert.match(html, /data-avatar-url="https:\/\/assets\.nightcord\.de5\.net\/avatars\/nako\.webp"/);
    assert.match(html, /class="entity-avatar__fallback"/);
  });

  test('scope 图标等可信 HTML 不被转义', () => {
    const html = authorizePage(baseApp, baseUser);
    assert.ok(html.includes('<svg'), '内置 SVG 图标属于可信 HTML');
    assert.ok(html.includes('class="scope-item"'));
  });

  test('缺省字段不会渲染成 undefined', () => {
    const html = authorizePage(
      { name: 'App', client_id: 'c', redirect_uri: 'https://x.example/cb' },
      { username: 'u' },
    );
    assert.ok(!html.includes('undefined'), '不应把 undefined 渲染进页面');
  });

  test('非法 redirect_uri 时主机名回落到 Unknown 而不抛异常', () => {
    const html = authorizePage({ ...baseApp, redirect_uri: 'not a url' }, baseUser);
    assert.ok(html.includes('Unknown'));
  });
});
