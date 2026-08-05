/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCaptchaProvider } from '../src/lib/captcha-provider.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('captcha provider', () => {
  test('未知 provider 被拒，缺省 provider 是 Turnstile', () => {
    assert.equal(getCaptchaProvider('unknown'), null);
    assert.equal(getCaptchaProvider(undefined)?.name, 'turnstile');
    assert.equal(getCaptchaProvider('turnstile')?.responseField, 'cf-turnstile-response');
  });

  test('hCaptcha 使用独立 response 字段和 siteverify endpoint', async () => {
    const calls: Request[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push(new Request(input, init));
      return new Response(JSON.stringify({ success: true, hostname: 'example.com' }), {
        headers: { 'content-type': 'application/json' },
      });
    };

    const provider = getCaptchaProvider('hcaptcha');
    assert.ok(provider);
    assert.equal(provider.responseField, 'h-captcha-response');
    const result = await provider.verify('token', 'secret');

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.hcaptcha.com/siteverify');
    assert.equal(calls[0].method, 'POST');
    const body = await calls[0].formData();
    assert.equal(body.get('secret'), 'secret');
    assert.equal(body.get('response'), 'token');
  });

  test('hCaptcha 缺少 token 或 secret 时拒绝且不请求网络', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('{}');
    };

    const provider = getCaptchaProvider('hcaptcha');
    assert.ok(provider);
    assert.equal((await provider.verify('', 'secret')).success, false);
    assert.equal((await provider.verify('token', '')).success, false);
    assert.equal(calls, 0);
  });
});
