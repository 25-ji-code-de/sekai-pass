/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proof-of-Work 反滥用的测试。
 *
 * PoW 是 Turnstile 不可用地区的兜底关卡。verifyPoWHash 只要在任何一种
 * 情况下过于宽松，注册端点的机器人成本就直接归零。
 *
 * 这里刻意用**低难度**来构造有效解 —— 真实难度 20/22 位需要约 100 万次
 * 哈希，不适合放进单元测试。难度语义本身由 hasLeadingZeroBits 的边界
 * 用例来钉住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  POW_DIFFICULTY,
  POW_DIFFICULTY_STRICT,
  createChallengeState,
  generatePoWChallenge,
  verifyPoWHash,
} from '../src/lib/pow.ts';

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 暴力搜一个满足 `difficulty` 位前导零的 nonce。只在低难度下用。 */
async function mine(challenge: string, difficulty: number): Promise<string> {
  for (let i = 0; i < 2_000_000; i++) {
    const nonce = String(i);
    if (await verifyPoWHash(challenge, nonce, difficulty)) return nonce;
  }
  throw new Error(`难度 ${difficulty} 下没挖到解`);
}

describe('难度常量', () => {
  test('严格难度必须高于基线', () => {
    assert.ok(POW_DIFFICULTY_STRICT > POW_DIFFICULTY);
  });

  test('严格难度是基线的 4 倍工作量（+2 位）', () => {
    assert.equal(POW_DIFFICULTY_STRICT - POW_DIFFICULTY, 2);
  });

  test('基线难度不能被误调低到无意义的程度', () => {
    assert.ok(POW_DIFFICULTY >= 16, '低于 16 位的 PoW 对机器人几乎没有成本');
  });
});

describe('generatePoWChallenge', () => {
  test('challenge 是 32 个十六进制字符（16 字节）', () => {
    const { challenge } = generatePoWChallenge();
    assert.match(challenge, /^[0-9a-f]{32}$/);
  });

  test('难度默认用基线，也可指定', () => {
    assert.equal(generatePoWChallenge().difficulty, POW_DIFFICULTY);
    assert.equal(generatePoWChallenge(POW_DIFFICULTY_STRICT).difficulty, POW_DIFFICULTY_STRICT);
  });

  test('连续生成不重复 —— challenge 复用会让解可以被重放', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePoWChallenge().challenge));
    assert.equal(seen.size, 500);
  });
});

describe('verifyPoWHash', () => {
  test('挖到的解能通过', async () => {
    const challenge = 'abcdef0123456789abcdef0123456789';
    const nonce = await mine(challenge, 12);
    assert.equal(await verifyPoWHash(challenge, nonce, 12), true);
  });

  test('换一个 challenge 后同一个 nonce 通常失效（解与 challenge 绑定）', async () => {
    const challenge = 'abcdef0123456789abcdef0123456789';
    const nonce = await mine(challenge, 12);
    const other = '0123456789abcdef0123456789abcdef';
    assert.equal(await verifyPoWHash(other, nonce, 12), false);
  });

  test('随便一个 nonce 在真实难度下不可能通过', async () => {
    const challenge = generatePoWChallenge().challenge;
    for (const nonce of ['0', '1', 'nonce', '']) {
      assert.equal(await verifyPoWHash(challenge, nonce, POW_DIFFICULTY), false, nonce);
    }
  });

  test('提高难度会让原来的解失效', async () => {
    const challenge = 'abcdef0123456789abcdef0123456789';
    // 找一个刚好满足 8 位、但不满足 16 位的解
    let nonce = '';
    for (let i = 0; i < 200_000; i++) {
      const candidate = String(i);
      if (
        (await verifyPoWHash(challenge, candidate, 8)) &&
        !(await verifyPoWHash(challenge, candidate, 16))
      ) {
        nonce = candidate;
        break;
      }
    }
    assert.notEqual(nonce, '', '应该能找到这样的 nonce');
    assert.equal(await verifyPoWHash(challenge, nonce, 8), true);
    assert.equal(await verifyPoWHash(challenge, nonce, 16), false);
  });

  test('难度 0 时一切通过（边界语义）', async () => {
    assert.equal(await verifyPoWHash('x', 'y', 0), true);
  });

  test('前导零判定按 bit 而不是按 nibble', async () => {
    // 造一个哈希前缀已知的输入，验证 5 位（1 个 nibble + 1 bit）的判定
    const challenge = 'deadbeefdeadbeefdeadbeefdeadbeef';
    let found = false;
    for (let i = 0; i < 500_000; i++) {
      const nonce = String(i);
      const hash = await sha256Hex(challenge + nonce);
      if (hash[0] === '0' && parseInt(hash[1], 16) >= 8) {
        // 前 4 位是零，第 5 位是 1 → 满足 4 位但不满足 5 位
        assert.equal(await verifyPoWHash(challenge, nonce, 4), true, '4 位应通过');
        assert.equal(await verifyPoWHash(challenge, nonce, 5), false, '5 位应失败');
        found = true;
        break;
      }
    }
    assert.ok(found, '应该能构造出这个边界用例');
  });
});

describe('createChallengeState', () => {
  test('初始状态是"什么都还没发生"', () => {
    const state = createChallengeState('1.2.3.4');
    assert.equal(state.ip, '1.2.3.4');
    assert.equal(state.turnstileAttempted, false);
    assert.equal(state.powIssued, false);
    assert.equal(state.powChallenge, null);
    assert.equal(state.used, false);
  });

  test('issued 是当前时间戳', () => {
    const before = Date.now();
    const state = createChallengeState('1.2.3.4');
    assert.ok(state.issued >= before && state.issued <= Date.now());
  });

  test('powDifficulty 初始不设置 —— 旧状态回落到基线难度', () => {
    // 注释里写明：写于难度分级之前的状态没有这个字段，应按基线处理
    assert.equal(createChallengeState('1.2.3.4').powDifficulty, undefined);
  });

  test('每次调用返回独立对象', () => {
    const a = createChallengeState('1.1.1.1');
    const b = createChallengeState('2.2.2.2');
    a.used = true;
    assert.equal(b.used, false);
  });
});
