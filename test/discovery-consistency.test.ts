/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 两个 well-known 端点必须描述同一台服务器。
 *
 * ── 由来 ────────────────────────────────────────────────────────
 *
 * 本服务对外发两份元数据：
 *
 *   /.well-known/oauth-authorization-server  （RFC 8414）
 *   /.well-known/openid-configuration        （OIDC Discovery 1.0）
 *
 * 它们此前是**两份手工维护的字面量** —— 一份在 oidc-discovery.ts，
 * 一份直接写在 index.ts 的路由里。抓出来的办法是把线上两个端点拉下来
 * 逐字段对比，结果 5 个字段互相矛盾：
 *
 *   scopes_supported                        openid 出现**两次**
 *   jwks_uri                                只有 OIDC 那份有
 *   revocation_endpoint_auth_methods_supported  只有 RFC 8414 那份有
 *   require_pushed_authorization_requests    同上
 *   require_request_uri_registration         同上
 *
 * 其中 jwks_uri 那条最实际：RFC 8414 那份文档**声明了签名算法却没说钥匙在哪**，
 * 只按 8414 接入的客户端找不到验签公钥。
 *
 * 而重复的 openid 来自 `["openid", ...Object.values(SCOPES)]` —— SCOPES
 * 本身第一项就是 openid。两份实现各写各的，谁也没发现对方不一样。
 *
 * ── 这批测试盯什么 ──────────────────────────────────────────────
 *
 * 不是「openid 不许出现两次」——那样只钉死这一个症状。盯的是产生它的那两个
 * 形状：**任何列表字段都不许有重复**，以及**两份文档共有的字段必须逐字相等**。
 * 下次再有人往任一份里加字段，加错地方就会红。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  generateOIDCMetadata,
  generateAuthorizationServerMetadata,
} from '../src/lib/oidc-discovery.ts';

const BASE = 'https://id.nightcord.de5.net';
const oidc = generateOIDCMetadata(BASE) as Record<string, unknown>;
const as = generateAuthorizationServerMetadata(BASE) as Record<string, unknown>;

/** OIDC Discovery 1.0 在 RFC 8414 之上独有的字段 —— 只应出现在 openid-configuration。 */
const OIDC_ONLY = new Set([
  'subject_types_supported',
  'id_token_signing_alg_values_supported',
  'claims_supported',
]);

describe('两份 discovery 文档描述同一台服务器', () => {
  test('两份都生成得出来（否则下面几条是空跑）', () => {
    assert.ok(Object.keys(as).length >= 10, `RFC 8414 那份只有 ${Object.keys(as).length} 个字段`);
    assert.ok(Object.keys(oidc).length > Object.keys(as).length, 'OIDC 那份应当是 8414 的超集');
  });

  test('OIDC 文档是 RFC 8414 文档的超集', () => {
    const missing = Object.keys(as).filter((k) => !(k in oidc));
    assert.deepEqual(
      missing,
      [],
      'RFC 8414 文档有而 OIDC 文档没有的字段 —— 同一台服务器不该只对一半客户端承认这些能力',
    );
  });

  test('共有字段逐字相等', () => {
    const differing: string[] = [];
    for (const k of Object.keys(as)) {
      if (JSON.stringify(as[k]) !== JSON.stringify(oidc[k])) {
        differing.push(`${k}: 8414=${JSON.stringify(as[k])} oidc=${JSON.stringify(oidc[k])}`);
      }
    }
    assert.deepEqual(differing, [], '两份文档对同一个字段说了不同的话');
  });

  test('OIDC 文档多出来的字段确实是 OIDC 独有的', () => {
    /*
     * 反过来钉：多出来的东西必须是**OIDC 规范要求的**，
     * 而不是「有人往 OIDC 那份里加了字段、忘了往 8414 那份加」。
     */
    const extra = Object.keys(oidc).filter((k) => !(k in as));
    const unexpected = extra.filter((k) => !OIDC_ONLY.has(k));
    assert.deepEqual(
      unexpected,
      [],
      '这些字段只加进了 OIDC 文档 —— 若它描述的是服务器能力，应当加进共有的那一份',
    );
  });

  test('RFC 8414 文档给得出验签公钥的位置', () => {
    // 声明了签名算法却不说钥匙在哪，只按 8414 接入的客户端验不了签
    assert.equal(as.jwks_uri, `${BASE}/.well-known/jwks.json`);
  });

  test('必备字段一个都不能少', () => {
    /*
     * 上面那几条测的都是「两份不一致」。它们有个盲区：把字段从**共有基底**
     * 删掉，两份会同时失去它 —— 依然一致，于是一条都不响。
     *
     * 这不是假想。写反向验证时我拿「删掉 revocation_endpoint_auth_methods_supported」
     * 当变异，结果全绿 —— 那条变异本身写错了（真正的分歧是「只加进一份」），
     * 但它顺带照出了这个缺口。
     *
     * 每一条为什么必须在：
     *   issuer / authorization_endpoint / token_endpoint  RFC 8414 §2 必填
     *   jwks_uri                       不给就没人验得了签名
     *   code_challenge_methods_supported  OAuth 2.1 强制 PKCE；不列等于说不支持
     *   revocation_endpoint_auth_methods_supported
     *                                  既然发了 revocation_endpoint，就得说清怎么认证
     */
    const REQUIRED = [
      'issuer',
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'revocation_endpoint',
      'revocation_endpoint_auth_methods_supported',
      'response_types_supported',
      'grant_types_supported',
      'code_challenge_methods_supported',
      'token_endpoint_auth_methods_supported',
      'scopes_supported',
    ];
    for (const [name, doc] of [
      ['openid-configuration', oidc],
      ['oauth-authorization-server', as],
    ] as const) {
      const missing = REQUIRED.filter(
        (k) => doc[k] === undefined || (Array.isArray(doc[k]) && (doc[k] as unknown[]).length === 0),
      );
      assert.deepEqual(missing, [], `${name} 缺了必备字段`);
    }
  });
});

describe('列表字段里没有重复值', () => {
  /*
   * 这条是那个 bug 的**泛化形状**。
   *
   * 具体犯的错是 `["openid", ...Object.values(SCOPES)]`，而 SCOPES 含 openid。
   * 但同样的错在任何一个 *_supported 上都可能重犯 —— 所以这里遍历所有
   * 数组字段，而不是只盯 scopes_supported。
   */
  for (const [name, doc] of [
    ['openid-configuration', oidc],
    ['oauth-authorization-server', as],
  ] as const) {
    test(name, () => {
      const dupes: string[] = [];
      for (const [k, v] of Object.entries(doc)) {
        if (!Array.isArray(v)) continue;
        const seen = new Set<unknown>();
        for (const item of v) {
          if (seen.has(item)) dupes.push(`${k} 里 ${JSON.stringify(item)} 出现多次`);
          seen.add(item);
        }
      }
      assert.deepEqual(dupes, [], `${name} 的列表字段里有重复值`);
    });
  }
});

describe('路由确实用的是这两个函数，不是又抄了一份', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
    'utf8',
  );

  /**
   * 剥注释再断言。
   *
   * 上面那段说明里逐字引用了 `scopes_supported`、`jwks_uri` 这些名字，
   * 不剥的话「路由里不再有手写字面量」这条会被自己的注释干扰。
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const [path, fn] of [
    ['/.well-known/oauth-authorization-server', 'generateAuthorizationServerMetadata'],
    ['/.well-known/openid-configuration', 'generateOIDCMetadata'],
  ] as const) {
    test(`${path} 调 ${fn}`, () => {
      const route = new RegExp(
        `app\\.get\\(\\s*["']${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][\\s\\S]*?\\n\\}\\);`,
      ).exec(code)?.[0];
      assert.ok(route, `找不到 ${path} 的路由`);
      assert.match(route, new RegExp(`\\b${fn}\\(`), `${path} 没有调 ${fn}`);
      /*
       * 而且路由体里不该再出现手写的元数据字段 —— 那正是当初漂移的起点：
       * 两处各写各的字面量。
       */
      assert.doesNotMatch(
        route,
        /scopes_supported|token_endpoint_auth_methods_supported/,
        `${path} 的路由里还有手写的元数据字段，会再次与另一份漂移`,
      );
    });
  }
});
