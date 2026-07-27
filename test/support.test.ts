/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `stripJsComments` 自己的测试。
 *
 * 工具函数不测，就是把一个静默失效的点从被测代码挪进了测试基础设施 ——
 * 而那里没人看着。这批测试里最要紧的一条是「字符串里的 `/*` 不算注释」，
 * 因为那正是它被写出来的原因。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stripJsComments } from './support.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('stripJsComments', () => {
  test('剥掉行注释', () => {
    assert.equal(stripJsComments('const a = 1; // 说明\nconst b = 2;'), 'const a = 1; \nconst b = 2;');
  });

  test('剥掉块注释，但保留换行（行号不变）', () => {
    const src = 'a\n/* 一\n   二 */\nb';
    const out = stripJsComments(src);
    assert.equal(out.split('\n').length, src.split('\n').length, '行数变了');
    assert.ok(!out.includes('一'), '块注释内容没剥干净');
    assert.match(out, /^a\n/);
    assert.match(out, /\nb$/);
  });

  test('**字符串里的 /* 不是注释开头**', () => {
    /*
     * 这条是整个文件存在的理由。
     * src/index.ts 里有 app.use("/api/*", ...) 这样的路由前缀。
     */
    const src = 'app.use("/api/*", h);\nconst x = 1;\n/* 真注释 */\nconst y = 2;';
    const out = stripJsComments(src);
    assert.match(out, /app\.use\("\/api\/\*", h\);/, '路由前缀被当成注释吃掉了');
    assert.match(out, /const x = 1;/, '中间的代码被吃掉了');
    assert.match(out, /const y = 2;/);
    assert.ok(!out.includes('真注释'));
  });

  test('字符串里的 // 不是行注释', () => {
    const src = "const u = 'https://example.test/a'; // 说明\n";
    const out = stripJsComments(src);
    assert.match(out, /https:\/\/example\.test\/a/, 'URL 被当成注释截断了');
    assert.ok(!out.includes('说明'));
  });

  test('转义引号不会提前结束字符串', () => {
    const src = 'const s = "他说 \\" // 这不是注释"; const t = 1;';
    const out = stripJsComments(src);
    assert.match(out, /这不是注释/);
    assert.match(out, /const t = 1;/);
  });

  test('模板字面量里的 /* 与 // 都不算注释', () => {
    const src = 'const t = `a/*b//c`; const d = 2;';
    const out = stripJsComments(src);
    assert.match(out, /`a\/\*b\/\/c`/);
    assert.match(out, /const d = 2;/);
  });

  test('没有结尾的块注释不会把后面吃光之后又吐出来', () => {
    // 语法上就是坏文件，但工具不该崩
    const out = stripJsComments('a\n/* 没关');
    assert.match(out, /^a\n/);
  });
});

describe('拿真实的 src/index.ts 验一遍', () => {
  const src = readFileSync(join(root, 'src/index.ts'), 'utf8');

  test('剥完之后路由注册还在', () => {
    /*
     * 朴素正则在这个文件上**必然**出错：`"/api/*"` 会开一个假注释。
     * 这条把「在真文件上成立」也钉住，而不只是构造的小例子。
     */
    const out = stripJsComments(src);
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/.well-known/jwks.json',
    ]) {
      assert.ok(out.includes(path), `剥完之后找不到 ${path} 的注册`);
    }
  });

  test('剥完之后 JSDoc 内容没了', () => {
    const out = stripJsComments(src);
    assert.ok(!/Enforce HTTPS for OAuth endpoints/.test(out), '块注释没剥掉');
  });

  test('朴素正则在这个文件上确实会出错（记录动机）', () => {
    /*
     * 这条**期望朴素写法失败**。它红的时候说明 index.ts 里那几个
     * 带 `/*` 的路由前缀没有了 —— 那时候可以考虑简化，
     * 但更可能是有人把路由改坏了。
     */
    const naive = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !naive.includes('/.well-known/oauth-authorization-server'),
      '朴素正则现在也能work了 —— 去确认 index.ts 里的 "/api/*" 这类前缀还在不在',
    );
  });
});
