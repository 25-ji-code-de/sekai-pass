/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 开放平台 —— OAuth 应用自助管理的测试。
 *
 * 最关键的一条：**所有读写都必须按 owner 过滤**。
 * 少一个 owner 条件，知道 client_id 就能读改删别人的应用。
 * 下面每个操作都有一条「换个 owner 就应该拿不到」的用例。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRedirectUri,
  validateApplicationInput,
  rowToApplication,
  listApplications,
  getApplication,
  createApplication,
  updateApplication,
  deleteApplication,
  isAtAppLimit,
  MAX_REDIRECT_URIS,
  MAX_NAME_LEN,
  MAX_APPS_PER_USER,
} from '../src/lib/applications.ts';

const OWNER = 'user-1';
const OTHER = 'user-2';

/** 极简的内存版 applications 表。 */
function fakeDb(rows: Record<string, unknown>[] = []) {
  const table = [...rows];
  const calls: { sql: string; args: unknown[] }[] = [];
  const batches: string[][] = [];

  const exec = (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    if (/SELECT \* FROM applications WHERE client_id = \? AND owner_user_id = \?/.test(sql)) {
      return table.find((r) => r.client_id === args[0] && r.owner_user_id === args[1]) ?? null;
    }
    if (/SELECT \* FROM applications WHERE owner_user_id = \?/.test(sql)) {
      return table.filter((r) => r.owner_user_id === args[0]);
    }
    if (/COUNT\(\*\)/.test(sql)) {
      return { n: table.filter((r) => r.owner_user_id === args[0]).length };
    }
    if (/^INSERT INTO applications/m.test(sql.trim())) {
      table.push({
        id: args[0], name: args[1], client_id: args[2], client_secret: args[3],
        redirect_uris: args[4], created_at: args[5], owner_user_id: args[6],
        token_endpoint_auth_method: args[7], description: args[8],
        homepage_url: args[9], updated_at: args[10],
      });
      return null;
    }
    if (/^UPDATE applications/.test(sql)) {
      const clientId = args[args.length - 2];
      const owner = args[args.length - 1];
      const row = table.find((r) => r.client_id === clientId && r.owner_user_id === owner);
      if (row) {
        const fields = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
        fields.forEach((f, i) => { row[f] = args[i]; });
      }
      return null;
    }
    if (/^DELETE FROM applications/.test(sql)) {
      const idx = table.findIndex((r) => r.client_id === args[0] && r.owner_user_id === args[1]);
      if (idx >= 0) table.splice(idx, 1);
      return null;
    }
    return null;
  };

  return {
    table, calls, batches,
    prepare(sql: string) {
      return {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) { this.args = args; return this; },
        async first() { const r = exec(sql, this.args); return Array.isArray(r) ? r[0] ?? null : r; },
        async all() { const r = exec(sql, this.args); return { results: Array.isArray(r) ? r : [] }; },
        async run() { exec(sql, this.args); return { success: true }; },
      };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      batches.push(stmts.map((s) => s.sql));
      for (const s of stmts) exec(s.sql, s.args);
      return stmts.map(() => ({ success: true }));
    },
  } as any;
}

const validInput = {
  name: '我的应用',
  redirect_uris: ['https://app.example/callback'],
};

describe('validateRedirectUri', () => {
  test('接受 https', () => {
    assert.equal(validateRedirectUri('https://app.example/cb'), null);
  });

  test('http 只允许 loopback', () => {
    assert.equal(validateRedirectUri('http://localhost:3000/cb'), null);
    assert.equal(validateRedirectUri('http://127.0.0.1:5173/cb'), null);
    assert.ok(validateRedirectUri('http://evil.example/cb'));
  });

  test('拒绝带 fragment 的 —— OAuth 2.1 明确禁止', () => {
    assert.ok(validateRedirectUri('https://app.example/cb#token'));
  });

  test('拒绝非绝对 URI', () => {
    for (const bad of ['/callback', 'callback', '', 'not a url']) {
      assert.ok(validateRedirectUri(bad), JSON.stringify(bad));
    }
  });

  test('接受原生 App 的自定义 scheme', () => {
    assert.equal(validateRedirectUri('com.example.app:/oauth'), null);
  });

  test('拒绝 javascript: 这类危险 scheme', () => {
    assert.ok(validateRedirectUri('javascript:alert(1)'));
    assert.ok(validateRedirectUri('data:text/html,x'));
  });

  test('超长被拒', () => {
    assert.ok(validateRedirectUri('https://a.example/' + 'x'.repeat(3000)));
  });
});

describe('validateApplicationInput', () => {
  test('合法输入无错误', () => {
    assert.deepEqual(validateApplicationInput(validInput), []);
  });

  test('应用名必填且有长度上限', () => {
    assert.ok(validateApplicationInput({ ...validInput, name: '' }).length);
    assert.ok(validateApplicationInput({ ...validInput, name: '   ' }).length);
    assert.ok(validateApplicationInput({ ...validInput, name: 'x'.repeat(MAX_NAME_LEN + 1) }).length);
  });

  test('至少一个回调地址，且有数量上限', () => {
    assert.ok(validateApplicationInput({ ...validInput, redirect_uris: [] }).length);
    const many = Array.from({ length: MAX_REDIRECT_URIS + 1 }, (_, i) => `https://a.example/${i}`);
    assert.ok(validateApplicationInput({ ...validInput, redirect_uris: many }).length);
  });

  test('回调地址重复被拒', () => {
    const errors = validateApplicationInput({
      ...validInput,
      redirect_uris: ['https://a.example/cb', 'https://a.example/cb'],
    });
    assert.ok(errors.some((e) => /重复/.test(e.message)));
  });

  test('错误里点名是第几个回调地址', () => {
    const errors = validateApplicationInput({
      ...validInput,
      redirect_uris: ['https://ok.example/cb', 'javascript:alert(1)'],
    });
    assert.ok(errors.some((e) => e.field === 'redirect_uris[1]'));
  });

  test('认证方式只接受白名单', () => {
    assert.deepEqual(
      validateApplicationInput({ ...validInput, token_endpoint_auth_method: 'none' }),
      [],
    );
    assert.ok(
      validateApplicationInput({ ...validInput, token_endpoint_auth_method: 'client_secret_basic' })
        .length,
    );
  });

  test('partial 模式下未传的字段不报错', () => {
    assert.deepEqual(validateApplicationInput({ name: '新名字' }, { partial: true }), []);
    assert.ok(validateApplicationInput({ name: '新名字' }).length, '非 partial 时缺回调地址应报错');
  });
});

describe('rowToApplication', () => {
  test('redirect_uris 从 JSON 解开', () => {
    const app = rowToApplication({
      id: 'i', name: 'n', client_id: 'c',
      redirect_uris: '["https://a/cb","https://b/cb"]',
      created_at: 1,
    });
    assert.deepEqual(app.redirect_uris, ['https://a/cb', 'https://b/cb']);
  });

  test('兼容历史的逗号分隔格式', () => {
    const app = rowToApplication({
      id: 'i', name: 'n', client_id: 'c',
      redirect_uris: 'https://a/cb, https://b/cb',
      created_at: 1,
    });
    assert.deepEqual(app.redirect_uris, ['https://a/cb', 'https://b/cb']);
  });

  test('认证方式缺省为 none', () => {
    assert.equal(
      rowToApplication({ id: 'i', name: 'n', client_id: 'c', redirect_uris: '[]', created_at: 1 })
        .token_endpoint_auth_method,
      'none',
    );
  });

  test('不外泄 client_secret', () => {
    const app = rowToApplication({
      id: 'i', name: 'n', client_id: 'c', client_secret: 'SECRET',
      redirect_uris: '[]', created_at: 1,
    });
    assert.ok(!('client_secret' in app), 'client_secret 绝不能进对外结构');
    assert.ok(!JSON.stringify(app).includes('SECRET'));
  });
});

describe('创建', () => {
  test('client_id 由服务端生成', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, validInput);

    assert.match(application.client_id, /^app_[A-Za-z0-9]{24}$/);
    assert.equal(application.owner_user_id, OWNER);
  });

  test('不返回 client_secret —— 本服务不用它认证任何东西', async () => {
    /*
     * token_endpoint_auth_methods_supported 只有 none 与 private_key_jwt
     * （见 index.ts 的 discovery 文档），authenticateClient 也只实现这两种。
     * 把一串随机字符标成「客户端密钥」交出去，接入方会把它配进后端，
     * 然后发现根本用不上 —— 或者更糟，以为自己的应用因此是机密的。
     */
    const db = fakeDb();
    const created = await createApplication(db, OWNER, validInput);
    assert.deepEqual(Object.keys(created), ['application']);
  });

  test('列仍然写，NOT NULL 约束在那儿', async () => {
    // 哪天真加 client_secret_basic 时不用改表；但它不会被任何接口读出来
    const db = fakeDb();
    await createApplication(db, OWNER, validInput);
    assert.match(String(db.table[0].client_secret), /^[A-Za-z0-9]{48}$/);
  });

  test('不接受调用方指定 client_id 或 owner', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, {
      ...validInput,
      // @ts-expect-error 故意传入不该被接受的字段
      client_id: 'attacker_chosen',
      owner_user_id: OTHER,
    });
    assert.notEqual(application.client_id, 'attacker_chosen');
    assert.equal(application.owner_user_id, OWNER);
  });

  test('连续创建的 client_id 不重复', async () => {
    const db = fakeDb();
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) {
      ids.add((await createApplication(db, OWNER, validInput)).application.client_id);
    }
    assert.equal(ids.size, 30);
  });

  test('应用数量上限', async () => {
    const db = fakeDb();
    assert.equal(await isAtAppLimit(db, OWNER), false);
    for (let i = 0; i < MAX_APPS_PER_USER; i++) await createApplication(db, OWNER, validInput);
    assert.equal(await isAtAppLimit(db, OWNER), true);
    assert.equal(await isAtAppLimit(db, OTHER), false, '上限是按用户算的');
  });
});

describe('权限隔离 —— 每个操作都必须按 owner 过滤', () => {
  async function seeded() {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, validInput);
    return { db, clientId: application.client_id };
  }

  test('列表只返回自己的', async () => {
    const { db } = await seeded();
    await createApplication(db, OTHER, { ...validInput, name: '别人的应用' });

    const mine = await listApplications(db, OWNER);
    const theirs = await listApplications(db, OTHER);
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 1);
    assert.equal(mine[0].name, '我的应用');
    assert.equal(theirs[0].name, '别人的应用');
  });

  test('读：换个 owner 拿不到', async () => {
    const { db, clientId } = await seeded();
    assert.ok(await getApplication(db, clientId, OWNER));
    assert.equal(await getApplication(db, clientId, OTHER), null);
  });

  test('改：换个 owner 改不动', async () => {
    const { db, clientId } = await seeded();
    assert.equal(await updateApplication(db, clientId, OTHER, { name: '被改了' }), null);
    assert.equal((await getApplication(db, clientId, OWNER))!.name, '我的应用', '原值必须没变');
  });

  test('删：换个 owner 删不掉', async () => {
    const { db, clientId } = await seeded();
    assert.equal(await deleteApplication(db, clientId, OTHER), false);
    assert.ok(await getApplication(db, clientId, OWNER), '应用必须还在');
  });

  test('不存在的 client_id 一律返回空而不是抛异常', async () => {
    const db = fakeDb();
    assert.equal(await getApplication(db, 'nope', OWNER), null);
    assert.equal(await updateApplication(db, 'nope', OWNER, { name: 'x' }), null);
    assert.equal(await deleteApplication(db, 'nope', OWNER), false);
  });
});

describe('更新', () => {
  test('只改传入的字段', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, {
      ...validInput,
      description: '原描述',
    });

    const updated = await updateApplication(db, application.client_id, OWNER, { name: '新名字' });
    assert.equal(updated!.name, '新名字');
    assert.equal(updated!.description, '原描述', '未传的字段不该被清掉');
    assert.deepEqual(updated!.redirect_uris, validInput.redirect_uris);
  });

  test('什么都不传时原样返回', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, validInput);
    const updated = await updateApplication(db, application.client_id, OWNER, {});
    assert.equal(updated!.name, application.name);
  });

  test('client_id 不会被改掉', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, validInput);
    const updated = await updateApplication(db, application.client_id, OWNER, {
      // @ts-expect-error 故意传入不该生效的字段
      client_id: 'hijacked',
      name: 'x',
    });
    assert.equal(updated!.client_id, application.client_id);
  });
});

describe('删除会级联清理', () => {
  test('连带清掉 token、授权码与公钥', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, validInput);
    await deleteApplication(db, application.client_id, OWNER);

    assert.equal(db.batches.length, 1, '级联删除必须在一个 batch 里');
    const sqls = db.batches[0].join(' | ');
    for (const table of ['access_tokens', 'refresh_tokens', 'auth_codes', 'client_keys', 'applications']) {
      assert.match(sqls, new RegExp(table), `漏了 ${table}`);
    }
  });

  test('不级联的话应用删了 token 还能用 —— 这条断言就是防这个', async () => {
    const db = fakeDb();
    const { application } = await createApplication(db, OWNER, validInput);
    await deleteApplication(db, application.client_id, OWNER);
    const sqls = db.batches[0].join(' | ');
    assert.match(sqls, /DELETE FROM access_tokens WHERE client_id = \?/);
  });
});

describe('没有假的密钥轮换', () => {
  test('applications.ts 不再导出 rotateClientSecret', async () => {
    // 轮换一个不认证任何东西的值，只会让人以为自己刚做了一次安全操作。
    // 真正有意义的密钥轮换在 client-keys.ts：登记新公钥 → 客户端换用
    // 新私钥 → 撤销旧公钥。
    const mod = await import('../src/lib/applications.ts');
    assert.ok(!('rotateClientSecret' in mod), '这个函数应当已经删掉');
  });
});
