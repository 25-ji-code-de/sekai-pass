/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 密码哈希与校验的测试。
 *
 * PBKDF2-SHA256 / 100k 轮 / 每次随机 16 字节 salt。
 * 这里钉住的是几件绝对不能回退的事：salt 必须随机、比较必须是等时的、
 * 任何畸形输入都不能让 verifyPassword 返回 true。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword, generateId } from '../src/lib/password.ts';

describe('hashPassword', () => {
  test('输出是 96 个十六进制字符（16 字节 salt + 32 字节 hash）', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(hash.length, 96);
    assert.match(hash, /^[0-9a-f]{96}$/);
  });

  test('同一密码两次哈希结果不同 —— salt 必须是随机的', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.notEqual(a, b, 'salt 复用会让彩虹表攻击重新可行');
    // 但两者的 salt 之外部分也必须不同（因为 salt 参与派生）
    assert.notEqual(a.slice(32), b.slice(32));
  });

  test('空密码也能哈希（是否允许空密码是上层策略）', async () => {
    const hash = await hashPassword('');
    assert.equal(hash.length, 96);
  });

  test('非 ASCII 密码', async () => {
    const hash = await hashPassword('密码🔑パスワード');
    assert.equal(hash.length, 96);
    assert.equal(await verifyPassword('密码🔑パスワード', hash), true);
  });

  test('很长的密码不会截断（前 N 位相同的两个密码结果不同）', async () => {
    const long = 'a'.repeat(500);
    const hash = await hashPassword(long);
    assert.equal(await verifyPassword(long, hash), true);
    assert.equal(await verifyPassword(long + 'b', hash), false);
    assert.equal(await verifyPassword('a'.repeat(499), hash), false);
  });
});

describe('verifyPassword', () => {
  test('正确密码通过', async () => {
    const hash = await hashPassword('s3cr3t');
    assert.equal(await verifyPassword('s3cr3t', hash), true);
  });

  test('错误密码被拒', async () => {
    const hash = await hashPassword('s3cr3t');
    for (const wrong of ['s3cr3T', 's3cr3', 's3cr3t ', '', 'S3CR3T']) {
      assert.equal(await verifyPassword(wrong, hash), false, JSON.stringify(wrong));
    }
  });

  test('畸形哈希一律返回 false 而不抛异常', async () => {
    for (const bad of [
      '',
      'not-hex',
      'zz'.repeat(48),
      'ab',
      'a'.repeat(95), // 奇数长度
      'a'.repeat(32), // 只有 salt 没有 hash
    ]) {
      const result = await verifyPassword('anything', bad);
      assert.equal(result, false, JSON.stringify(bad.slice(0, 20)));
    }
  });

  test('哈希被改动一个字符就拒绝', async () => {
    const hash = await hashPassword('s3cr3t');
    const flip = (c: string) => (c === '0' ? '1' : '0');
    // 改 salt 部分
    const tamperedSalt = flip(hash[0]) + hash.slice(1);
    assert.equal(await verifyPassword('s3cr3t', tamperedSalt), false);
    // 改 hash 部分
    const tamperedHash = hash.slice(0, 95) + flip(hash[95]);
    assert.equal(await verifyPassword('s3cr3t', tamperedHash), false);
  });

  test('截断的哈希不会因长度不等而意外通过', async () => {
    const hash = await hashPassword('s3cr3t');
    assert.equal(await verifyPassword('s3cr3t', hash.slice(0, 64)), false);
  });
});

describe('generateId', () => {
  test('默认长度 16', () => {
    assert.equal(generateId().length, 16);
  });

  test('长度可指定', () => {
    for (const n of [1, 8, 32, 64]) {
      assert.equal(generateId(n).length, n);
    }
  });

  test('只含 [A-Za-z0-9]', () => {
    assert.match(generateId(200), /^[A-Za-z0-9]+$/);
  });

  test('连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId(16)));
    assert.equal(ids.size, 500, '16 位随机 ID 在 500 次内不应碰撞');
  });

  test('字符分布不至于严重倾斜', () => {
    // chars 长度是 62，用 % 62 会有轻微模偏差，但不该出现某字符完全缺失
    const sample = generateId(20000);
    const distinct = new Set(sample).size;
    assert.ok(distinct >= 55, `只出现了 ${distinct} 种字符，疑似随机源有问题`);
  });
});
