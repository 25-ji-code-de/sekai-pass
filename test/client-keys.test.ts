/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * private_key_jwt 公钥自助管理的测试。
 *
 * 两条主线：
 *
 * 1. **owner 隔离** —— 和 applications 一样，知道别人的 client_id
 *    也不能列/加/改/删他的公钥。
 * 2. **别让用户把私钥贴进来** —— 私钥 JWK 和公钥 JWK 只差几个字段，
 *    复制错一个非常容易，而存进来就是私钥明文落库。这一条要挡死，
 *    并且必须报错而不是"顺手帮他去掉私钥部分"，否则用户不会知道
 *    自己该去轮换密钥。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateJwk,
  validateKeyId,
  importCheck,
  rowToClientKey,
  listClientKeys,
  addClientKey,
  setClientKeyStatus,
  deleteClientKey,
  MAX_KEYS_PER_APP,
  KEY_ALGORITHMS,
} from '../src/lib/client-keys.ts';

const OWNER = 'user-1';
const OTHER = 'user-2';
const CLIENT = 'app_abc';

let ecPublicJwk: Record<string, unknown>;
let ecPrivateJwk: Record<string, unknown>;
let rsaPublicJwk: Record<string, unknown>;

before(async () => {
  const ec = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  ecPublicJwk = (await crypto.subtle.exportKey('jwk', ec.publicKey)) as Record<string, unknown>;
  ecPrivateJwk = (await crypto.subtle.exportKey('jwk', ec.privateKey)) as Record<string, unknown>;

  const rsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  rsaPublicJwk = (await crypto.subtle.exportKey('jwk', rsa.publicKey)) as Record<string, unknown>;
});

/** 内存版 applications + client_keys 两张表。 */
function fakeDb({ owner = OWNER, keys = [] as Record<string, unknown>[] } = {}) {
  const apps = [{ id: 'a1', name: 'App', client_id: CLIENT, owner_user_id: owner, redirect_uris: '[]', created_at: 1 }];
  const table = [...keys];

  const exec = (sql: string, args: unknown[]): any => {
    if (/SELECT \* FROM applications WHERE client_id = \? AND owner_user_id = \?/.test(sql)) {
      return apps.find((r) => r.client_id === args[0] && r.owner_user_id === args[1]) ?? null;
    }
    if (/SELECT \* FROM client_keys WHERE client_id = \? AND key_id = \?/.test(sql)) {
      return table.find((r) => r.client_id === args[0] && r.key_id === args[1]) ?? null;
    }
    if (/SELECT key_id FROM client_keys WHERE client_id = \? AND key_id = \?/.test(sql)) {
      return table.find((r) => r.client_id === args[0] && r.key_id === args[1]) ?? null;
    }
    if (/SELECT \* FROM client_keys WHERE client_id = \?/.test(sql)) {
      return table.filter((r) => r.client_id === args[0]);
    }
    if (/COUNT\(\*\) AS n FROM client_keys/.test(sql)) {
      return { n: table.filter((r) => r.client_id === args[0]).length };
    }
    if (/^INSERT INTO client_keys/m.test(sql.trim())) {
      table.push({
        client_id: args[0], key_id: args[1], public_key_jwk: args[2],
        algorithm: args[3], status: 'active', created_at: args[4],
      });
      return { changes: 1 };
    }
    if (/^UPDATE client_keys SET status/.test(sql)) {
      const row = table.find((r) => r.client_id === args[1] && r.key_id === args[2]);
      if (!row) return { changes: 0 };
      row.status = args[0];
      return { changes: 1 };
    }
    if (/^DELETE FROM client_keys/.test(sql)) {
      const i = table.findIndex((r) => r.client_id === args[0] && r.key_id === args[1]);
      if (i < 0) return { changes: 0 };
      table.splice(i, 1);
      return { changes: 1 };
    }
    return null;
  };

  return {
    table,
    prepare(sql: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) { this.args = args; return this; },
        async first() { const r = exec(sql, this.args); return Array.isArray(r) ? (r[0] ?? null) : r; },
        async all() { const r = exec(sql, this.args); return { results: Array.isArray(r) ? r : [] }; },
        async run() { return { success: true, meta: exec(sql, this.args) ?? { changes: 0 } }; },
      };
    },
  } as any;
}

describe('validateJwk —— 私钥必须被挡住', () => {
  test('EC 私钥（含 d）被拒，且报错说明它是私钥', () => {
    const errors = validateJwk(ecPrivateJwk, 'ES256');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /私钥/);
    assert.match(errors[0].message, /\bd\b/);
    assert.match(errors[0].message, /重新生成/);
  });

  test('RSA 私钥的每个特征字段都被认出来', () => {
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
      const errors = validateJwk({ ...rsaPublicJwk, [field]: 'x' }, 'RS256');
      assert.equal(errors.length, 1, field);
      assert.match(errors[0].message, /私钥/, field);
    }
  });

  test('对称密钥（含 k）被拒', () => {
    const errors = validateJwk({ kty: 'oct', k: 'AAAA' }, 'ES256');
    assert.match(errors[0].message, /私钥/);
  });

  test('私钥字段优先于其它错误报出来 —— 不能被格式问题盖住', () => {
    const errors = validateJwk({ ...ecPrivateJwk, crv: 'P-384', use: 'enc' }, 'ES256');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /私钥/);
  });

  test('不会"顺手删掉私钥部分再存"', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: ecPrivateJwk,
      algorithm: 'ES256',
    });
    assert.equal(result.ok, false);
    assert.equal(db.table.length, 0, '不能悄悄存一份剥掉 d 的版本');
  });
});

describe('validateJwk —— 公钥的结构校验', () => {
  test('合法 EC 公钥通过', () => {
    assert.deepEqual(validateJwk(ecPublicJwk, 'ES256'), []);
  });

  test('合法 RSA 公钥通过', () => {
    assert.deepEqual(validateJwk(rsaPublicJwk, 'RS256'), []);
  });

  test('非对象被拒', () => {
    for (const bad of [null, 'x', 42, ['a']]) {
      assert.equal(validateJwk(bad, 'ES256').length, 1, JSON.stringify(bad));
    }
  });

  test('不支持的算法被拒', () => {
    for (const alg of ['HS256', 'none', 'ES384', '']) {
      const errors = validateJwk(ecPublicJwk, alg);
      assert.ok(errors.some((e) => e.field === 'algorithm'), alg);
    }
  });

  test('只支持 ES256 / RS256', () => {
    assert.deepEqual([...KEY_ALGORITHMS], ['ES256', 'RS256']);
  });

  test('JWK 自带的 alg 与声明不符会报', () => {
    const errors = validateJwk({ ...ecPublicJwk, alg: 'RS256' }, 'ES256');
    assert.ok(errors.some((e) => /alg 是 RS256/.test(e.message)));
  });

  test('use 不是 sig 会报', () => {
    const errors = validateJwk({ ...ecPublicJwk, use: 'enc' }, 'ES256');
    assert.ok(errors.some((e) => /use 必须是/.test(e.message)));
  });

  test('key_ops 不含 verify 会报', () => {
    const errors = validateJwk({ ...ecPublicJwk, key_ops: ['encrypt'] }, 'ES256');
    assert.ok(errors.some((e) => /key_ops/.test(e.message)));
  });

  test('ES256 要求 kty=EC 且 crv=P-256', () => {
    assert.ok(validateJwk({ ...ecPublicJwk, kty: 'RSA' }, 'ES256').some((e) => /kty/.test(e.message)));
    assert.ok(validateJwk({ ...ecPublicJwk, crv: 'P-384' }, 'ES256').some((e) => /crv/.test(e.message)));
  });

  test('EC 缺 x / y 会报', () => {
    for (const f of ['x', 'y']) {
      const jwk = { ...ecPublicJwk };
      delete jwk[f];
      assert.ok(validateJwk(jwk, 'ES256').some((e) => e.message.includes(f)), f);
    }
  });

  test('RSA 模数不足 2048 位会报', () => {
    const errors = validateJwk({ kty: 'RSA', n: 'AQAB'.repeat(10), e: 'AQAB' }, 'RS256');
    assert.ok(errors.some((e) => /2048/.test(e.message)));
  });

  test('超长 JWK 被拒', () => {
    const errors = validateJwk({ ...ecPublicJwk, junk: 'x'.repeat(5000) }, 'ES256');
    assert.ok(errors.some((e) => /太长/.test(e.message)));
  });
});

describe('importCheck —— 结构对但 WebCrypto 不认的', () => {
  test('真实公钥能导入', async () => {
    assert.equal(await importCheck(ecPublicJwk, 'ES256'), null);
    assert.equal(await importCheck(rsaPublicJwk, 'RS256'), null);
  });

  test('坐标不在曲线上的 EC 公钥被拒', async () => {
    // x/y 长度合法、base64url 合法，但不是曲线上的点
    const bogus = { ...ecPublicJwk, x: 'A'.repeat(43), y: 'B'.repeat(43) };
    assert.ok(await importCheck(bogus, 'ES256'), '这种错误只有导入时才暴露');
  });

  test('导入失败会拦在注册这一步，而不是等到取 token 报"签名无效"', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: { ...ecPublicJwk, x: 'A'.repeat(43), y: 'B'.repeat(43) },
      algorithm: 'ES256',
    });
    assert.equal(result.ok, false);
    assert.equal(db.table.length, 0);
  });
});

describe('validateKeyId', () => {
  test('不给是合法的 —— 服务端会生成', () => {
    assert.deepEqual(validateKeyId(undefined), []);
    assert.deepEqual(validateKeyId(''), []);
  });

  test('接受保守字符集', () => {
    assert.deepEqual(validateKeyId('my-key_2026.v1~a'), []);
  });

  test('拒绝会出现在 JWT header 里的危险字符', () => {
    for (const bad of ['a b', 'a/b', 'a"b', 'a\nb', '<script>', 'a\\b']) {
      assert.equal(validateKeyId(bad).length, 1, JSON.stringify(bad));
    }
  });

  test('拒绝超长与非字符串', () => {
    assert.equal(validateKeyId('a'.repeat(200)).length, 1);
    assert.equal(validateKeyId(42).length, 1);
  });
});

describe('rowToClientKey', () => {
  test('解开 JSON 形式的 JWK', () => {
    const key = rowToClientKey({
      client_id: CLIENT, key_id: 'k1', algorithm: 'ES256', status: 'active',
      created_at: 100, public_key_jwk: JSON.stringify({ kty: 'EC' }),
    });
    assert.deepEqual(key.public_key_jwk, { kty: 'EC' });
  });

  test('坏数据不至于让整个列表接口 500', () => {
    const key = rowToClientKey({
      client_id: CLIENT, key_id: 'k1', created_at: 1, public_key_jwk: '{ not json',
    });
    assert.deepEqual(key.public_key_jwk, {});
    assert.equal(key.algorithm, 'ES256');
    assert.equal(key.status, 'active');
  });
});

describe('owner 隔离', () => {
  const seeded = [{ client_id: CLIENT, key_id: 'k1', public_key_jwk: '{}', algorithm: 'ES256', status: 'active', created_at: 1 }];

  test('列表：别人拿到 client_id 也读不到', async () => {
    const db = fakeDb({ keys: seeded });
    assert.ok(await listClientKeys(db, CLIENT, OWNER));
    assert.equal(await listClientKeys(db, CLIENT, OTHER), null);
  });

  test('注册：别人加不了', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OTHER, {
      public_key_jwk: ecPublicJwk, algorithm: 'ES256',
    });
    assert.equal(result.ok, false);
    assert.ok('notFound' in result);
    assert.equal(db.table.length, 0);
  });

  test('改状态：别人改不了', async () => {
    const db = fakeDb({ keys: seeded.map((k) => ({ ...k })) });
    assert.equal(await setClientKeyStatus(db, CLIENT, OTHER, 'k1', 'revoked'), null);
    assert.equal(db.table[0].status, 'active', '状态不能被改动');
  });

  test('删除：别人删不掉', async () => {
    const db = fakeDb({ keys: seeded.map((k) => ({ ...k })) });
    assert.equal(await deleteClientKey(db, CLIENT, OTHER, 'k1'), false);
    assert.equal(db.table.length, 1);
  });
});

describe('addClientKey', () => {
  test('注册成功，返回的 JWK 带上 kid / alg / use', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: ecPublicJwk, algorithm: 'ES256', key_id: 'my-key',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.key_id, 'my-key');
    assert.equal(result.key.status, 'active');
    assert.equal(result.key.public_key_jwk.kid, 'my-key');
    assert.equal(result.key.public_key_jwk.alg, 'ES256');
    assert.equal(result.key.public_key_jwk.use, 'sig');
  });

  test('不给 key_id 时用 JWK 自带的 kid', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: { ...ecPublicJwk, kid: 'from-jwk' }, algorithm: 'ES256',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.key.key_id, 'from-jwk');
  });

  test('两边都没有时服务端生成一个', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: ecPublicJwk, algorithm: 'ES256',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.key.key_id, /^key_[A-Za-z0-9]{16}$/);
      // 生成的 kid 自己也必须落在允许的字符集内，否则注册完立刻就是坏数据
      assert.deepEqual(validateKeyId(result.key.key_id), []);
    }
  });

  test('生成的 kid 每次都不同', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const db = fakeDb();
      const result = await addClientKey(db, CLIENT, OWNER, { public_key_jwk: ecPublicJwk });
      if (result.ok) seen.add(result.key.key_id);
    }
    assert.equal(seen.size, 20);
  });

  test('显式 key_id 优先于 JWK 自带的 kid', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: { ...ecPublicJwk, kid: 'from-jwk' }, algorithm: 'ES256', key_id: 'explicit',
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.key.key_id, 'explicit');
  });

  test('JWK 自带的 kid 也要过字符集校验', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, {
      public_key_jwk: { ...ecPublicJwk, kid: 'bad kid"with quotes' }, algorithm: 'ES256',
    });
    assert.equal(result.ok, false);
    assert.equal(db.table.length, 0);
  });

  test('默认算法是 ES256', async () => {
    const db = fakeDb();
    const result = await addClientKey(db, CLIENT, OWNER, { public_key_jwk: ecPublicJwk });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.key.algorithm, 'ES256');
  });

  test('key_id 重复被拒', async () => {
    const db = fakeDb();
    await addClientKey(db, CLIENT, OWNER, { public_key_jwk: ecPublicJwk, key_id: 'k1' });
    const again = await addClientKey(db, CLIENT, OWNER, { public_key_jwk: ecPublicJwk, key_id: 'k1' });
    assert.equal(again.ok, false);
    if (!again.ok && 'errors' in again) assert.match(again.errors[0].message, /已存在/);
    assert.equal(db.table.length, 1);
  });

  test('数量达到上限后拒绝', async () => {
    const keys = Array.from({ length: MAX_KEYS_PER_APP }, (_, i) => ({
      client_id: CLIENT, key_id: `k${i}`, public_key_jwk: '{}', algorithm: 'ES256', status: 'active', created_at: i,
    }));
    const db = fakeDb({ keys });
    const result = await addClientKey(db, CLIENT, OWNER, { public_key_jwk: ecPublicJwk, key_id: 'one-more' });
    assert.equal(result.ok, false);
    if (!result.ok && 'errors' in result) assert.match(result.errors[0].message, /上限/);
    assert.equal(db.table.length, MAX_KEYS_PER_APP);
  });

  test('上限留出了轮换期间新旧并存的余量', () => {
    assert.ok(MAX_KEYS_PER_APP >= 2);
  });
});

describe('setClientKeyStatus / deleteClientKey', () => {
  const seeded = () => [{ client_id: CLIENT, key_id: 'k1', public_key_jwk: '{}', algorithm: 'ES256', status: 'active', created_at: 1 }];

  test('撤销后状态变 revoked，但记录还在', async () => {
    const db = fakeDb({ keys: seeded() });
    const key = await setClientKeyStatus(db, CLIENT, OWNER, 'k1', 'revoked');
    assert.equal(key?.status, 'revoked');
    assert.equal(db.table.length, 1, '撤销不是删除 —— 要留下"这个 kid 存在过"的记录');
  });

  test('撤销后可以恢复', async () => {
    const db = fakeDb({ keys: seeded() });
    await setClientKeyStatus(db, CLIENT, OWNER, 'k1', 'revoked');
    const key = await setClientKeyStatus(db, CLIENT, OWNER, 'k1', 'active');
    assert.equal(key?.status, 'active');
  });

  test('非法状态被拒', async () => {
    const db = fakeDb({ keys: seeded() });
    assert.equal(await setClientKeyStatus(db, CLIENT, OWNER, 'k1', 'deleted' as any), null);
    assert.equal(db.table[0].status, 'active');
  });

  test('不存在的 key_id 返回 null / false', async () => {
    const db = fakeDb({ keys: seeded() });
    assert.equal(await setClientKeyStatus(db, CLIENT, OWNER, 'nope', 'revoked'), null);
    assert.equal(await deleteClientKey(db, CLIENT, OWNER, 'nope'), false);
  });

  test('删除真的删掉', async () => {
    const db = fakeDb({ keys: seeded() });
    assert.equal(await deleteClientKey(db, CLIENT, OWNER, 'k1'), true);
    assert.equal(db.table.length, 0);
  });
});
