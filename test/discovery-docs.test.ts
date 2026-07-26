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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/index.ts'), 'utf8');
const doc = readFileSync(join(root, 'docs/api/discovery.md'), 'utf8');

/** 从 src/index.ts 里读一个字符串数组字段。 */
function codeArray(field: string): string[] {
  const m = new RegExp(`${field}:\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(m, `src/index.ts 里找不到 ${field}`);
  return m![1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
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
  const FILES = [
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
