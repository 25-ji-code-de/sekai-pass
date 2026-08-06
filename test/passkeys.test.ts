/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  base64URLToBytes,
  bytesToBase64URL,
  encodeUserHandle,
  getPasskeyRP,
  isPasskeyChallengeFresh,
  normalizePasskeyName,
  parsePasskeyChallenge,
  parseTransports,
  toWebAuthnCredential,
} from "../src/lib/passkeys.ts";

const root = join(import.meta.dirname, "..");

describe("Passkey RP 配置", () => {
  test("生产请求精确绑定当前 hostname 与 origin", () => {
    assert.deepEqual(
      getPasskeyRP("https://id.nightcord.de5.net/api/auth/passkeys/login/options"),
      {
        rpID: "id.nightcord.de5.net",
        origin: "https://id.nightcord.de5.net",
        rpName: "SEKAI Pass",
      },
    );
  });

  test("本地开发端口不进入 RP ID", () => {
    const rp = getPasskeyRP("http://localhost:8787/api/auth/passkeys/login/options");
    assert.equal(rp.rpID, "localhost");
    assert.equal(rp.origin, "http://localhost:8787");
  });
});

describe("Passkey 数据转换", () => {
  test("base64url 可无损保存 COSE 公钥字节", () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const encoded = bytesToBase64URL(bytes);
    assert.doesNotMatch(encoded, /[+/=]/);
    assert.deepEqual([...base64URLToBytes(encoded)], [...bytes]);
  });

  test("数据库行转换保留 credential、counter 与 transports", () => {
    const publicKey = Uint8Array.from([164, 1, 2, 3, 4]);
    const credential = toWebAuthnCredential({
      credential_id: "credential-id",
      user_id: "user-id",
      public_key: bytesToBase64URL(publicKey),
      counter: 42,
      transports: '["internal","hybrid"]',
      device_type: "multiDevice",
      backed_up: 1,
      name: "Phone",
      created_at: 1,
      last_used_at: null,
    });
    assert.equal(credential.id, "credential-id");
    assert.equal(credential.counter, 42);
    assert.deepEqual([...credential.publicKey], [...publicKey]);
    assert.deepEqual(credential.transports, ["internal", "hybrid"]);
  });

  test("损坏的 transports 不会污染验证参数", () => {
    assert.equal(parseTransports("not-json"), undefined);
    assert.equal(parseTransports('["internal",1]'), undefined);
  });

  test("user handle 使用稳定的 UTF-8 base64url 编码", () => {
    assert.equal(encodeUserHandle("user-123"), "dXNlci0xMjM");
  });
});

describe("Passkey challenge 与名称校验", () => {
  test("只接受完整的注册 challenge", () => {
    const state = {
      challenge: "challenge",
      rpID: "id.example.com",
      origin: "https://id.example.com",
      userId: "user-1",
      createdAt: Date.now(),
    };
    assert.deepEqual(parsePasskeyChallenge(JSON.stringify(state), true), state);
    assert.equal(parsePasskeyChallenge(JSON.stringify({ ...state, userId: undefined }), true), null);
    assert.equal(parsePasskeyChallenge("{", false), null);
  });

  test("五分钟内有效，过期后拒绝", () => {
    const fresh = { challenge: "c", rpID: "r", origin: "o", createdAt: Date.now() };
    const stale = { ...fresh, createdAt: Date.now() - 5 * 60 * 1000 - 1 };
    assert.equal(isPasskeyChallengeFresh(fresh), true);
    assert.equal(isPasskeyChallengeFresh(stale), false);
  });

  test("名称会去除首尾空格并限制长度", () => {
    assert.equal(normalizePasskeyName("  我的手机  "), "我的手机");
    assert.equal(normalizePasskeyName("   "), null);
    assert.equal(normalizePasskeyName("x".repeat(51)), null);
    assert.equal(normalizePasskeyName(null), null);
  });
});

describe("Passkey 集成文件", () => {
  test("schema 与迁移包含完整凭据表", () => {
    for (const file of ["schema.sql", "migrations/002_add_passkeys.sql"]) {
      const sql = readFileSync(join(root, file), "utf8");
      assert.match(sql, /CREATE TABLE IF NOT EXISTS passkeys/);
      for (const column of [
        "credential_id",
        "user_id",
        "public_key",
        "counter",
        "transports",
        "device_type",
        "backed_up",
        "name",
        "created_at",
        "last_used_at",
      ]) {
        assert.match(sql, new RegExp(`\\b${column}\\b`), `${file} 缺少 ${column}`);
      }
    }
  });

  test("浏览器调用标准 WebAuthn API，登录与设置页均已接入", () => {
    const helper = readFileSync(join(root, "public/js/webauthn.js"), "utf8");
    const login = readFileSync(join(root, "public/js/pages/login.js"), "utf8");
    const settings = readFileSync(join(root, "public/js/pages/settings.js"), "utf8");
    assert.match(helper, /navigator\.credentials\.create/);
    assert.match(helper, /navigator\.credentials\.get/);
    assert.match(login, /\/auth\/passkeys\/login\/verify/);
    assert.match(settings, /\/auth\/passkeys\/register\/verify/);
    assert.match(settings, /\/auth\/passkeys\/\$\{encodeURIComponent/);
  });
});
