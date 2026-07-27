/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth 客户端认证（RFC 7523 private_key_jwt）的测试。
 *
 * 这是 token 端点的准入关卡。测试用**真实的 ES256 密钥对**签出 assertion，
 * 不做桩 —— 只有这样才能验证签名校验真的生效。
 *
 * 值得一提：这里的验签算法取自数据库的 client_keys 记录，
 * **不是**从 JWT header 读的。这比 lib/jwt.ts 的 verifyJWT 做得对
 * （后者在未显式传 algorithm 时会信任 header 里的 alg）。
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { authenticateClient, cleanupExpiredJTIs } from '../src/lib/client-auth.ts';

const TOKEN_ENDPOINT = 'https://id.nightcord.de5.net/oauth/token';
const CLIENT_ID = 'confidential_client';
const KEY_ID = 'key-1';

let privateKey: CryptoKey;
let publicKeyJWK: JsonWebKey;
let otherPrivateKey: CryptoKey;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  publicKeyJWK = await crypto.subtle.exportKey('jwk', pair.publicKey);

  const other = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  otherPrivateKey = other.privateKey;
});

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of u8) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** 用给定私钥签一个 client assertion。 */
async function signAssertion(
  claims: Record<string, unknown>,
  key: CryptoKey = privateKey,
  header: Record<string, unknown> = { alg: 'ES256', typ: 'JWT', kid: KEY_ID },
): Promise<string> {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    enc.encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

/** 默认的合法 claim 集合。 */
function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: TOKEN_ENDPOINT,
    exp: now + 300,
    iat: now,
    jti: `jti-${Math.floor(now)}-${Object.keys(overrides).join('')}`,
    ...overrides,
  };
}

/**
 * 按 SQL 关键字分派返回值的假 D1。
 * `seenJti` 模拟重放缓存。
 */
function fakeDb(options: { authMethod?: string; hasApp?: boolean; hasKey?: boolean; seenJti?: Set<string> } = {}) {
  const {
    authMethod = 'private_key_jwt',
    hasApp = true,
    hasKey = true,
    seenJti = new Set<string>(),
  } = options;
  const inserts: { sql: string; args: unknown[] }[] = [];

  return {
    inserts,
    seenJti,
    prepare(sql: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          if (/INSERT|DELETE/.test(sql)) inserts.push({ sql, args });
          return this;
        },
        async first() {
          if (sql.includes('FROM applications')) {
            return hasApp ? { client_id: CLIENT_ID, token_endpoint_auth_method: authMethod } : null;
          }
          if (sql.includes('FROM client_keys')) {
            return hasKey ? { public_key_jwk: JSON.stringify(publicKeyJWK), algorithm: 'ES256' } : null;
          }
          if (sql.includes('FROM jwt_replay_cache')) {
            return seenJti.has(this.args[0] as string) ? { jti: this.args[0] } : null;
          }
          return null;
        },
        async run() {
          // 按真实的 INSERT OR IGNORE 语义返回 changes：
          // (jti, client_id) 是主键，冲突时静默跳过、changes 为 0。
          // 防重放的权威判定就落在这个数字上。
          if (/INSERT OR IGNORE INTO jwt_replay_cache/.test(sql)) {
            const jti = this.args[0] as string;
            if (seenJti.has(jti)) return { success: true, meta: { changes: 0 } };
            seenJti.add(jti);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as any;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function authWith(claims: Record<string, unknown>, db = fakeDb(), key = privateKey) {
  const assertion = await signAssertion(claims, key);
  return authenticateClient(
    db,
    form({
      client_id: CLIENT_ID,
      client_assertion: assertion,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    }),
    TOKEN_ENDPOINT,
  );
}

describe('基本准入', () => {
  test('缺 client_id 被拒', async () => {
    const r = await authenticateClient(fakeDb(), form({}), TOKEN_ENDPOINT);
    assert.equal(r.authenticated, false);
    assert.equal(r.error, 'invalid_request');
  });

  test('未注册的 client 被拒', async () => {
    const r = await authenticateClient(
      fakeDb({ hasApp: false }),
      form({ client_id: 'ghost' }),
      TOKEN_ENDPOINT,
    );
    assert.equal(r.authenticated, false);
    assert.equal(r.error, 'invalid_client');
  });

  test('auth_method 为 none 时按公开客户端放行（PKCE 是它的保护）', async () => {
    const r = await authenticateClient(
      fakeDb({ authMethod: 'none' }),
      form({ client_id: CLIENT_ID }),
      TOKEN_ENDPOINT,
    );
    assert.equal(r.authenticated, true);
    assert.equal(r.clientId, CLIENT_ID);
  });

  test('不支持的 auth_method 被拒', async () => {
    for (const method of ['client_secret_basic', 'client_secret_post', 'bogus']) {
      const r = await authenticateClient(
        fakeDb({ authMethod: method }),
        form({ client_id: CLIENT_ID }),
        TOKEN_ENDPOINT,
      );
      assert.equal(r.authenticated, false, method);
      assert.equal(r.error, 'invalid_client', method);
    }
  });

  test('private_key_jwt 缺 assertion 被拒', async () => {
    const r = await authenticateClient(fakeDb(), form({ client_id: CLIENT_ID }), TOKEN_ENDPOINT);
    assert.equal(r.authenticated, false);
    assert.equal(r.error, 'invalid_client');
  });

  test('assertion_type 不对被拒', async () => {
    const assertion = await signAssertion(validClaims());
    const r = await authenticateClient(
      fakeDb(),
      form({ client_id: CLIENT_ID, client_assertion: assertion, client_assertion_type: 'bogus' }),
      TOKEN_ENDPOINT,
    );
    assert.equal(r.authenticated, false);
  });
});

describe('合法 assertion 通过', () => {
  test('真实签名的 assertion 认证成功', async () => {
    const r = await authWith(validClaims({ jti: 'ok-1' }));
    assert.equal(r.authenticated, true, r.errorDescription);
    assert.equal(r.clientId, CLIENT_ID);
  });

  test('aud 是数组时也接受', async () => {
    const r = await authWith(validClaims({ jti: 'ok-2', aud: [TOKEN_ENDPOINT, 'https://other'] }));
    assert.equal(r.authenticated, true, r.errorDescription);
  });

  test('通过后把 jti 写入重放缓存', async () => {
    const db = fakeDb();
    await authWith(validClaims({ jti: 'ok-3' }), db);
    const insert = db.inserts.find((i: any) => i.sql.includes('jwt_replay_cache'));
    assert.ok(insert, '必须记录 jti，否则防重放形同虚设');
    assert.equal(insert.args[0], 'ok-3');
    assert.equal(insert.args[1], CLIENT_ID);
  });
});

describe('RFC 7523 的 claim 校验', () => {
  test('缺任一必需 claim 被拒', async () => {
    for (const missing of ['iss', 'sub', 'aud', 'exp', 'jti']) {
      const claims = validClaims({ jti: `m-${missing}` });
      delete (claims as Record<string, unknown>)[missing];
      const r = await authWith(claims);
      assert.equal(r.authenticated, false, missing);
      assert.match(r.errorDescription!, new RegExp(missing));
    }
  });

  test('iss / sub 必须等于 client_id', async () => {
    assert.equal((await authWith(validClaims({ jti: 'i1', iss: 'attacker' }))).authenticated, false);
    assert.equal((await authWith(validClaims({ jti: 'i2', sub: 'attacker' }))).authenticated, false);
  });

  test('aud 必须匹配 token 端点 —— 否则别处签的 assertion 能拿来用', async () => {
    const r = await authWith(validClaims({ jti: 'a1', aud: 'https://evil.example/token' }));
    assert.equal(r.authenticated, false);
    assert.match(r.errorDescription!, /audience/i);
  });

  test('已过期的 assertion 被拒', async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await authWith(validClaims({ jti: 'e1', exp: now - 10 }));
    assert.equal(r.authenticated, false);
    assert.match(r.errorDescription!, /expired/i);
  });

  test('exp 太远的被拒（上限 1 小时）—— 限制被盗 assertion 的可用窗口', async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await authWith(validClaims({ jti: 'e2', exp: now + 3500 }))).authenticated, true);
    const r = await authWith(validClaims({ jti: 'e3', exp: now + 7200 }));
    assert.equal(r.authenticated, false);
    assert.match(r.errorDescription!, /too far in the future/i);
  });

  test('iat 在未来太多被拒（容忍 60 秒时钟偏移）', async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await authWith(validClaims({ jti: 'c1', iat: now + 30 }))).authenticated, true);
    const r = await authWith(validClaims({ jti: 'c2', iat: now + 600 }));
    assert.equal(r.authenticated, false);
  });
});

describe('防重放', () => {
  test('同一个 jti 第二次被拒', async () => {
    const seen = new Set<string>(['used-jti']);
    const r = await authWith(validClaims({ jti: 'used-jti' }), fakeDb({ seenJti: seen }));
    assert.equal(r.authenticated, false);
    assert.match(r.errorDescription!, /replay/i);
  });

  test('先查后插拦不住并发 —— 占用必须是原子的', async () => {
    /*
     * 两个请求带同一个 assertion 同时到达：
     * 旧实现里两边的 SELECT 都会 miss（那时还没人写进去），
     * 于是两边都通过认证，重放正好成立。
     *
     * 这里模拟这个交错：先做一次「SELECT 时还没有」的认证，
     * 但在它写入之前，让另一个请求已经把 jti 占掉。
     */
    const seen = new Set<string>();
    const db = fakeDb({ seenJti: seen });
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = original(sql);
      if (/FROM jwt_replay_cache/.test(sql)) {
        // SELECT 一律 miss —— 模拟"另一个请求还没写进去"
        stmt.first = async () => null;
      }
      return stmt;
    };

    // 另一个并发请求抢先占住了这个 jti
    seen.add('racy');

    const r = await authWith(validClaims({ jti: 'racy' }), db);
    assert.equal(r.authenticated, false, 'SELECT 漏掉时必须靠 INSERT 兜住');
    assert.match(r.errorDescription!, /replay/i);
  });

  test('占用写不进去时拒绝认证，而不是放行', async () => {
    // 旧实现把 INSERT 的异常吞掉了（"storage fails 也不影响认证"）——
    // 那等于说"防重放写不进去就不防了"，方向是反的
    const db = fakeDb();
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = original(sql);
      if (/INSERT OR IGNORE INTO jwt_replay_cache/.test(sql)) {
        stmt.run = async () => {
          throw new Error('D1 write failed');
        };
      }
      return stmt;
    };

    const r = await authWith(validClaims({ jti: 'write-fails' }), db);
    assert.equal(r.authenticated, false);
  });

  test('用的是 INSERT OR IGNORE，判定落在数据库的原子性上', async () => {
    const db = fakeDb();
    await authWith(validClaims({ jti: 'atomic' }), db);
    const insert = db.inserts.find((i: any) => i.sql.includes('jwt_replay_cache'));
    assert.match(insert.sql, /INSERT OR IGNORE/);
  });

  test('jti 按 client 隔离查询', async () => {
    // SQL 是 WHERE jti = ? AND client_id = ?，两个都绑定
    const db = fakeDb();
    await authWith(validClaims({ jti: 'scoped' }), db);
    const insert = db.inserts.find((i: any) => i.sql.includes('jwt_replay_cache'));
    assert.equal(insert.args[1], CLIENT_ID);
  });

  test('cleanupExpiredJTIs 只删过期的', async () => {
    const db = fakeDb();
    const before = Date.now();
    await cleanupExpiredJTIs(db);
    const del = db.inserts.find((i: any) => i.sql.includes('DELETE'));
    assert.match(del.sql, /expires_at < \?/);
    const bound = del.args[0] as number;
    assert.ok(bound >= before && bound <= Date.now());
  });
});

describe('签名校验', () => {
  test('用别的私钥签的 assertion 被拒', async () => {
    const r = await authWith(validClaims({ jti: 's1' }), fakeDb(), otherPrivateKey);
    assert.equal(r.authenticated, false);
    assert.match(r.errorDescription!, /signature/i);
  });

  test('篡改 payload 后验签失败', async () => {
    const claims = validClaims({ jti: 's2' });
    const good = await signAssertion(claims);
    const [h, , s] = good.split('.');
    // 加一个无害字段：全部 claim 检查照样通过，但字节变了 —— 只有签名会拦住它。
    // （不能改 iss/aud/exp，那样会先被 claim 检查拒掉，测不到签名这一层）
    const evil = b64url(new TextEncoder().encode(JSON.stringify({ ...claims, extra: 'x' })));
    const r = await authenticateClient(
      fakeDb(),
      form({
        client_id: CLIENT_ID,
        client_assertion: `${h}.${evil}.${s}`,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      }),
      TOKEN_ENDPOINT,
    );
    assert.equal(r.authenticated, false);
  });

  test('客户端没注册公钥时被拒', async () => {
    const r = await authWith(validClaims({ jti: 's3' }), fakeDb({ hasKey: false }));
    assert.equal(r.authenticated, false);
  });

  test('算法取自数据库而非 JWT header —— 挡住算法混淆', async () => {
    // header 声称 RS256，但库里登记的是 ES256；签名是 ES256 签的。
    // 若实现信任 header，就会按 RSA 导入 EC 公钥 → 失败；
    // 若正确地用库里的 ES256，仍应通过。
    const assertion = await signAssertion(validClaims({ jti: 's4' }), privateKey, {
      alg: 'RS256',
      typ: 'JWT',
      kid: KEY_ID,
    });
    const r = await authenticateClient(
      fakeDb(),
      form({
        client_id: CLIENT_ID,
        client_assertion: assertion,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      }),
      TOKEN_ENDPOINT,
    );
    assert.equal(r.authenticated, true, `应按库里登记的 ES256 验签：${r.errorDescription}`);
  });

  test('畸形 assertion 返回 invalid_client 而不抛异常', async () => {
    for (const bad of ['', 'a', 'a.b', 'not.a.jwt']) {
      const r = await authenticateClient(
        fakeDb(),
        form({
          client_id: CLIENT_ID,
          client_assertion: bad,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        }),
        TOKEN_ENDPOINT,
      );
      assert.equal(r.authenticated, false, JSON.stringify(bad));
    }
  });
});
