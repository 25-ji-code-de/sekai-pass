/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ID Token claim 构造与 OIDC scope 映射的测试。
 *
 * ID Token 是依赖方用来断言「用户是谁」的凭据，里面放了什么就等于披露了什么。
 *
 * 这里有一处**三方不一致**（见 issue，本测试只钉住现状、不改行为）：
 * 对 admin scope，三个描述「能看到什么」的函数各说各话 ——
 *   buildIDTokenClaims  → 给全部 profile + email 字段（用 hasScopes，admin 一票通过）
 *   filterUserData      → 空对象（用 includes，admin 不含 profile）
 *   getClaimsForScope   → 只有 sub
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildIDTokenClaims, EMAIL_VERIFIED, ACR } from '../src/lib/id-token.ts';
import { isOIDCRequest, getClaimsForScope, validateOIDCScope } from '../src/lib/oidc-scope.ts';
import { filterUserData } from '../src/lib/scope.ts';

const root = join(import.meta.dirname, '..');

const user = {
  id: 'u1',
  username: 'nako',
  display_name: 'なこ',
  email: 'nako@example.com',
  avatar_url: 'https://cdn.example/a.png',
  bio: '25時、コードで。',
  password_hash: 'PBKDF2$deadbeef',
};

const ISSUER = 'https://id.nightcord.de5.net';
const CLIENT = 'hub_client';

/** 除去所有协议字段，只留用户数据字段。 */
function userClaims(claims: Record<string, unknown>): string[] {
  const protocolFields = ['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'acr', 'amr', 'nonce'];
  return Object.keys(claims).filter((k) => !protocolFields.includes(k)).sort();
}

const build = (scope: string, nonce: string | null = null) =>
  buildIDTokenClaims(user, CLIENT, ISSUER, nonce, Date.now(), scope);

describe('协议字段', () => {
  test('iss / sub / aud 来自参数', () => {
    const c = build('openid profile');
    assert.equal(c.iss, ISSUER);
    assert.equal(c.sub, user.id);
    assert.equal(c.aud, CLIENT);
  });

  test('有效期 1 小时，且 iat 是秒级', () => {
    const now = Math.floor(Date.now() / 1000);
    const c = build('openid');
    assert.ok(c.iat >= now - 1 && c.iat <= now + 1);
    assert.equal(c.exp - c.iat, 3600);
  });

  test('auth_time 从毫秒转成秒', () => {
    const authTime = 1_700_000_000_000;
    const c = buildIDTokenClaims(user, CLIENT, ISSUER, null, authTime, 'openid');
    assert.equal(c.auth_time, 1_700_000_000);
  });

  test('nonce 给了才带 —— 防重放要靠它', () => {
    assert.equal(build('openid').nonce, undefined);
    assert.equal(build('openid', 'n-abc').nonce, 'n-abc');
  });

  test('带上认证上下文 acr / amr', () => {
    const c = build('openid');
    assert.equal(typeof c.acr, 'string');
    assert.deepEqual(c.amr, ['pwd']);
  });
});

describe('按 scope 披露用户字段', () => {
  test('profile 给 name / preferred_username / picture / bio', () => {
    assert.deepEqual(userClaims(build('openid profile')), [
      'bio',
      'name',
      'picture',
      'preferred_username',
    ]);
  });

  test('email 给 email 与 email_verified', () => {
    assert.deepEqual(userClaims(build('openid email')), ['email', 'email_verified']);
  });

  test('没有 email scope 就不含 email', () => {
    for (const scope of ['openid', 'openid profile', 'applications']) {
      assert.ok(!('email' in build(scope)), scope);
    }
  });

  describe('email_verified 必须是 false', () => {
    /*
     * 本服务没有任何邮箱验证流程：注册只要求邮箱唯一，不发确认信，
     * 库里也没有记录验证状态的字段。此前这里硬编码 `true`，
     * 注释写着 `// Assuming verified`。
     *
     * OIDC Core §5.1 说这个 claim 为 True 当且仅当邮箱**已被验证**。
     * 发 true 就是在断言一件我们从没做过的事 —— 而很多接入方按
     * 「邮箱已验证」做账号关联，于是攻击者用受害者的邮箱在这里注册，
     * 就能接管受害者在**那边**的账号。
     *
     * 要改成 true，先做验证流程，再改这里 —— 顺序不能反。
     */

    test('ID Token 里是 false', () => {
      assert.equal(build('openid email').email_verified, false);
    });

    test('常量导出的就是 false', () => {
      assert.equal(EMAIL_VERIFIED, false);
    });

    test('userinfo 与 ID Token 用同一个常量（不会各发各的）', () => {
      // 两处发不一样的值，接入方无所适从，且没有任何东西会报错
      const index = readFileSync(join(root, 'src/index.ts'), 'utf8');
      assert.match(
        index,
        /userInfo\.email_verified = EMAIL_VERIFIED;/,
        'userinfo 没有用 EMAIL_VERIFIED 常量',
      );
      assert.match(
        index,
        /import \{[^}]*EMAIL_VERIFIED[^}]*\} from "\.\/lib\/id-token\.ts"/,
        'index.ts 没有从 id-token.ts 引入这个常量',
      );
    });

    test('赋值处不再写死 true', () => {
      /*
       * 注意断言的是**赋值语句**，不是「文件里不出现某个字符串」——
       * 解释「为什么改掉」的注释里当然会引用原来那句
       * `= true; // Assuming verified`。我第一版就这么写，
       * 结果被自己的注释绊倒了。
       */
      for (const f of ['src/index.ts', 'src/lib/id-token.ts']) {
        const src = readFileSync(join(root, f), 'utf8');
        for (const m of src.matchAll(/^[^\n/*]*email_verified\s*=\s*([^;]+);/gm)) {
          assert.equal(
            m[1].trim(),
            'EMAIL_VERIFIED',
            `${f} 里 email_verified 被赋成了 ${m[1].trim()}`,
          );
        }
      }
    });

    test('文档里的示例响应与代码一致', () => {
      /*
       * 文档抄错没人会发现 —— 除非有东西盯着。这里盯的是：
       * 示例 JSON 里的 email_verified 必须与代码发的值相同。
       */
      const DOCS = [
        'README.md',
        'README.en.md',
        'docs/features/oidc/implementation.md',
        'docs/features/oidc/README.md',
      ];
      for (const f of DOCS) {
        const text = readFileSync(join(root, f), 'utf8');
        for (const m of text.matchAll(/"email_verified":\s*(\w+)/g)) {
          assert.equal(
            m[1],
            String(EMAIL_VERIFIED),
            `${f} 的示例里写着 "email_verified": ${m[1]}，而代码发的是 ${EMAIL_VERIFIED}`,
          );
        }
      }
    });

    test('两份 README 都说清了「别拿这个邮箱做账号关联」', () => {
      // 光把值改成 false 不够 —— 接入方看到 false 也未必知道该怎么办
      for (const [f, needle] of [
        ['README.md', /不要用这里的 `email` 做账号关联/],
        ['README.en.md', /Do not use this `email` for account linking/],
      ] as const) {
        assert.match(readFileSync(join(root, f), 'utf8'), needle, `${f} 缺少这条提醒`);
      }
    });

    test('真的做了验证流程之后，这批测试要一起改', () => {
      /*
       * 这条是提醒：库里出现验证状态字段时，上面几条会挡路 ——
       * 那时候该做的是把 EMAIL_VERIFIED 换成按用户读取，
       * 而不是把这些断言删掉了事。
       */
      const schema = readFileSync(join(root, 'schema.sql'), 'utf8');
      assert.doesNotMatch(
        schema,
        /email_verified|email_verified_at|email_confirmed/,
        'schema 里出现了邮箱验证字段 —— 说明验证流程做了，' +
          'EMAIL_VERIFIED 应当改成按用户读取，而不是继续写死 false',
      );
    });
  });

  describe('acr 不得声称我们没有的身份保障等级', () => {
    /*
     * 与 email_verified 同一类问题。此前无条件发
     * `urn:mace:incommon:iap:silver` —— 而 InCommon 的 Silver 是一套
     * **有具体要求**的等级：身份核验（比对政府证件或等效手段）、凭据强度与
     * 生命周期规定、可审计。
     *
     * 本服务是自助注册 + 一个连确认信都不发的邮箱 + 一个密码。
     *
     * OIDC Core §2：值 "0" 表示未达到 ISO/IEC 29115 level 1。
     */

    test('发的是 "0"', () => {
      assert.equal(build('openid profile email').acr, '0');
      assert.equal(ACR, '0');
    });

    test('赋值处用常量，不写死字面量', () => {
      const src = readFileSync(join(root, 'src/lib/id-token.ts'), 'utf8');
      for (const m of src.matchAll(/^[^\n/*]*claims\.acr\s*=\s*([^;]+);/gm)) {
        assert.equal(m[1].trim(), 'ACR', `acr 被赋成了 ${m[1].trim()}`);
      }
    });

    test('amr 仍然是 pwd —— 那一条本来就是准确的', () => {
      // 不该因为「acr 说错了」就把旁边正确的那条一起改掉
      assert.deepEqual(build('openid').amr, ['pwd']);
    });

    test('文档里的 acr 示例与代码一致', () => {
      const doc = readFileSync(join(root, 'docs/features/oidc/implementation.md'), 'utf8');
      for (const m of doc.matchAll(/"acr":\s*"([^"]*)"/g)) {
        assert.equal(m[1], ACR, `文档写着 "acr": "${m[1]}"，代码发的是 "${ACR}"`);
      }
    });

    test('文档说清了什么时候可以改', () => {
      // 「以后想发别的值该满足什么条件」不写下来的话，下次有人直接改常量
      const doc = readFileSync(join(root, 'docs/features/oidc/implementation.md'), 'utf8');
      assert.match(doc, /acr_values_supported/, '没写「改了要在 discovery 里声明」');
    });
  });

  test('绝不外泄 password_hash', () => {
    for (const scope of ['openid profile email', 'admin', '']) {
      assert.ok(!('password_hash' in build(scope)), scope);
    }
  });

  test('可选字段缺失时不出现', () => {
    const minimal = { id: 'u2', username: 'x', display_name: 'X' };
    const c = buildIDTokenClaims(minimal, CLIENT, ISSUER, null, Date.now(), 'openid profile');
    assert.ok(!('picture' in c));
    assert.ok(!('bio' in c));
    assert.equal(c.preferred_username, 'x');
  });
});

describe('admin scope 的三方不一致（钉住现状，见 issue）', () => {
  const ADMIN = 'admin';

  test('ID Token 给全部 profile + email 字段', () => {
    // buildIDTokenClaims 用 hasScopes，而 hasScopes 里 admin 一票通过
    assert.deepEqual(userClaims(build(ADMIN)), [
      'bio',
      'email',
      'email_verified',
      'name',
      'picture',
      'preferred_username',
    ]);
  });

  test('userinfo 端点却什么都不给', () => {
    // filterUserData 用 includes，admin 不含 profile/email
    assert.deepEqual(filterUserData(user, ADMIN), {});
  });

  test('getClaimsForScope 声称只有 sub', () => {
    assert.deepEqual(getClaimsForScope(ADMIN), ['sub']);
  });

  test('三者对同一个 scope 的答案互相矛盾', () => {
    const inIdToken = userClaims(build(ADMIN)).length;
    const inUserinfo = Object.keys(filterUserData(user, ADMIN)).length;
    const declared = getClaimsForScope(ADMIN).filter((c) => c !== 'sub').length;

    assert.ok(inIdToken > 0, 'ID Token 给了字段');
    assert.equal(inUserinfo, 0, 'userinfo 一个不给');
    assert.equal(declared, 0, '声明里也说没有');
    // 这条断言就是矛盾本身。修复方向确定后应当改成三者一致。
    assert.notEqual(inIdToken, declared, '现状：ID Token 比声明的多');
  });
});

describe('isOIDCRequest', () => {
  test('含 openid 才算 OIDC 请求', () => {
    assert.equal(isOIDCRequest('openid profile'), true);
    assert.equal(isOIDCRequest('profile'), false);
    assert.equal(isOIDCRequest(null), false);
    assert.equal(isOIDCRequest(''), false);
  });

  test('要整词匹配，不能被子串蒙混', () => {
    assert.equal(isOIDCRequest('openidx'), false);
    assert.equal(isOIDCRequest('notopenid'), false);
  });
});

describe('getClaimsForScope', () => {
  test('sub 永远在', () => {
    for (const scope of ['', 'profile', 'email', 'openid', 'bogus']) {
      assert.ok(getClaimsForScope(scope).includes('sub'), scope);
    }
  });

  test('openid 追加 auth_time', () => {
    assert.ok(getClaimsForScope('openid').includes('auth_time'));
    assert.ok(!getClaimsForScope('profile').includes('auth_time'));
  });

  test('结果去重', () => {
    const claims = getClaimsForScope('openid profile profile email');
    assert.equal(claims.length, new Set(claims).size);
  });

  test('未知 scope 不追加任何 claim', () => {
    assert.deepEqual(getClaimsForScope('bogus'), ['sub']);
  });
});

describe('validateOIDCScope', () => {
  test('接受合法组合', () => {
    assert.equal(validateOIDCScope('openid profile email').valid, true);
  });

  test('空值有明确的处理结果', () => {
    // 不断言具体取值，只要求不抛异常并给出布尔
    assert.equal(typeof validateOIDCScope(null).valid, 'boolean');
    assert.equal(typeof validateOIDCScope(undefined).valid, 'boolean');
  });
});
