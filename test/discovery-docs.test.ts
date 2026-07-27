/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * discovery 文档必须和代码说同一件事。
 *
 * 这批测试的由来：`docs/api/discovery.md` 里的示例 JSON 与
 * `src/index.ts` 实际返回的值有三处不一致，其中两处是会误导人去做错事的：
 *
 *   - 文档写 `code_challenge_methods_supported: ["S256", "plain"]`，
 *     代码只接受 `S256`。`plain` 是 OAuth 2.1 明令禁止的降级写法，
 *     文档摆在那里就是在邀请人用。
 *   - 文档写 `token_endpoint_auth_methods_supported: ["client_secret_post", …]`，
 *     代码根本没有 client_secret 这条路径。**开放平台第一版会做出
 *     「复制这个 client_secret」那一屏，多半就是被这份文档带偏的。**
 *
 * 文档抄错没人会发现 —— 除非有东西盯着。这就是那个东西。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateOIDCMetadata } from '../src/lib/oidc-discovery.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'docs/api/discovery.md'), 'utf8');

/*
 * 真值取自**真的调一次生成函数**，不再用正则刮 src/index.ts 的文本。
 *
 * 原先刮源码是因为那时元数据就是路由里的一堆字面量，没有别的取法。
 * 现在两个 well-known 端点共用一个生成函数，直接调它更严：
 * 刮文本只能看见「源码里写着什么」，调用看见的是「端点真的会吐什么」。
 *
 * （字面量搬走的那一刻这四条就红了 —— 正好说明它盯的是写在哪儿，
 *   而不是发出去的是什么。）
 */
const metadata = generateOIDCMetadata('https://id.nightcord.de5.net') as Record<string, unknown>;

/** 从生成的 discovery 文档里读一个字符串数组字段。 */
function codeArray(field: string): string[] {
  const value = metadata[field];
  assert.ok(Array.isArray(value), `生成的 discovery 文档里找不到数组字段 ${field}`);
  return value as string[];
}

/** 从文档的示例 JSON 里读同一个字段。 */
function docArray(field: string): string[] {
  const m = new RegExp(`"${field}":\\s*\\[([^\\]]*)\\]`).exec(doc);
  assert.ok(m, `discovery.md 里找不到 ${field}`);
  return m![1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

const FIELDS = [
  'response_types_supported',
  'grant_types_supported',
  'code_challenge_methods_supported',
  'token_endpoint_auth_methods_supported',
];

describe('discovery 文档与代码一致', () => {
  for (const field of FIELDS) {
    test(field, () => {
      assert.deepEqual(docArray(field), codeArray(field));
    });
  }
});

describe('几条不能松的底线', () => {
  test('只接受 S256，绝不把 plain 列为支持', () => {
    /*
     * OAuth 2.1 明令禁止 plain：它让 code_challenge 等于 code_verifier，
     * 能读到授权请求的攻击者就能自己把 code 换成 token。
     *
     * 禁的是「把 plain 列进支持列表」，不是「提到 plain」——
     * 文档里有一行专门说明它不被支持，那是应该留着的。
     */
    assert.deepEqual(codeArray('code_challenge_methods_supported'), ['S256']);

    for (const m of doc.matchAll(/"code_challenge_methods(?:_supported)?":\s*\[([^\]]*)\]/g)) {
      assert.ok(!/plain/.test(m[1]), `discovery.md 把 plain 列进了支持列表：${m[0]}`);
    }
  });

  test('客户端认证方式里没有任何 client_secret 变体', () => {
    /*
     * 有 client_secret_basic / client_secret_post 的话，
     * 开放平台就该发密钥；没有的话就不该发。两边必须对得上，
     * 否则要么用户拿到用不了的密钥，要么接入方按文档配了却认证失败。
     */
    const methods = codeArray('token_endpoint_auth_methods_supported');
    assert.deepEqual(methods, ['none', 'private_key_jwt']);
    assert.ok(
      !methods.some((m) => m.startsWith('client_secret')),
      '出现了 client_secret 变体 —— 那开放平台就得同步支持发密钥',
    );
  });

  test('签名算法与 client-auth.ts 的实现对得上', () => {
    // 声明了却没实现，接入方会登记一把永远验不过的公钥
    const declared = codeArray('token_endpoint_auth_signing_alg_values_supported');
    const impl = readFileSync(join(root, 'src/lib/client-auth.ts'), 'utf8');
    for (const alg of declared) {
      assert.match(impl, new RegExp(`"${alg}"`), `声明了 ${alg} 但 client-auth.ts 里没实现`);
    }
  });
});

describe('文档里不再教人用 client_secret', () => {
  /*
   * 这份清单最初漏了两份 README —— 而它们恰恰是新人看的第一份文档，
   * 里面那句「保存输出的 client_id 和 client_secret」正好命中下面第三条禁例。
   * 守卫写了却没指向要守的地方，等于没写。
   */
  const FILES = [
    'README.md',
    'README.en.md',
    'docs/api/examples.md',
    'docs/features/oauth/README.md',
    'docs/features/oidc/quickstart.md',
  ];

  for (const file of FILES) {
    test(file, () => {
      const text = readFileSync(join(root, file), 'utf8');
      /*
       * 允许**说明**没有 client_secret，也允许在折叠起来的"老办法"里
       * 出现（那是为了让照着旧笔记做的人能对上号）。
       * 禁的是把它当成正常步骤：curl 里传、注册时填。
       */
      const forbidden = [
        /-d "client_secret=/,
        /"client_secret":\s*"your/,
        /保存输出的 `client_id` 和 `client_secret`/,
      ];
      for (const re of forbidden) {
        assert.ok(!re.test(text), `${file} 里还在教人用 client_secret：${re}`);
      }
    });
  }
});

describe('文档里不再教人进库里手工注册应用', () => {
  /*
   * 「一直没有管理端，每次都进库里改」正是开放平台要解决的问题。
   * 它做完之后，两份 README 还在原样教手工 INSERT —— 而且插的是一个
   * （按开放平台的设计）认证不了任何东西的 client_secret。
   *
   * 文档不跟着改，等于功能没做：照着 README 走的人一样在进库里改。
   */
  const FILES = ['README.md', 'README.en.md'];

  for (const file of FILES) {
    test(file, () => {
      const text = readFileSync(join(root, file), 'utf8');

      assert.doesNotMatch(
        text,
        /INSERT INTO applications/i,
        '还在教人手工往 applications 表里插行',
      );
      assert.doesNotMatch(
        text,
        /应用管理 UI 正在开发中/,
        'UI 已经有了（仪表板 -> 开放平台 -> /apps）',
      );
      assert.match(
        text,
        /\/apps/,
        '得告诉人自助管理在哪儿',
      );
    });
  }

  test('开放平台的入口确实存在（不能只是文档这么写）', () => {
    // 文档说「仪表板点开放平台」，那就得真有这么个按钮和这么条路由
    const dashboard = readFileSync(join(root, 'public/js/pages/dashboard.js'), 'utf8');
    const app = readFileSync(join(root, 'public/js/app.js'), 'utf8');
    assert.match(dashboard, /navigate\('\/apps'\)/, '仪表板上没有通往 /apps 的入口');
    assert.match(app, /'\/apps':/, '路由表里没有 /apps');
  });
});
