/*
 * Copyright 2026 The 25-ji-code-de Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * private_key_jwt 客户端公钥的自助管理。
 *
 * 开放平台第一版把应用管起来了，但 client_keys 还是只能手工插库 ——
 * 也就是说 `token_endpoint_auth_method` 选了 private_key_jwt 的应用，
 * 在注册公钥之前**根本没法取 token**。这个模块补上那一步。
 *
 * 权限模型与 applications 一致：先确认应用属于该 owner，再动它的公钥。
 * 所有查询都带 owner 过滤，拿到别人的 client_id 也读不到、加不了、删不掉。
 */

import type { D1Database } from "@cloudflare/workers-types";
import { generateId } from "./password.ts";
import { getApplication } from "./applications.ts";
import type { ValidationError } from "./applications.ts";

/** 单个应用能注册的公钥数量上限。留出轮换期间新旧并存的余量。 */
export const MAX_KEYS_PER_APP = 10;
/** key_id 长度上限。 */
export const MAX_KEY_ID_LEN = 128;
/** 序列化后的 JWK 长度上限 —— RSA-4096 的公钥 JWK 也就 800 字节左右。 */
export const MAX_JWK_LEN = 4096;

/** 支持的签名算法。与 client-auth.ts 的验签实现严格对应。 */
export const KEY_ALGORITHMS = ["ES256", "RS256"] as const;
export type KeyAlgorithm = (typeof KEY_ALGORITHMS)[number];

export const KEY_STATUSES = ["active", "revoked"] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

export interface ClientKey {
  client_id: string;
  key_id: string;
  algorithm: KeyAlgorithm;
  status: KeyStatus;
  created_at: number;
  /** 公钥 JWK 本身。公钥没有保密价值，可以原样回显。 */
  public_key_jwk: Record<string, unknown>;
}

/**
 * JWK 里一旦出现这些字段，说明贴进来的是**私钥**而不是公钥。
 *
 * 这是本模块最重要的一条校验。用户从 `jose`/`openssl` 导出密钥对时，
 * 私钥 JWK 和公钥 JWK 长得几乎一样 —— 只多几个字段 —— 复制错一个非常容易。
 * 存进来之后就是把私钥明文写进了服务端数据库，而客户端多半还在继续用它签名。
 *
 * 所以宁可报错也不能"顺手帮他去掉私钥部分再存" ——
 * 那样用户不会知道自己刚把私钥贴进了一个公开表单，也就不会去轮换它。
 */
const PRIVATE_KEY_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];

/**
 * 校验一个 JWK 是否可以作为客户端公钥注册。
 *
 * 只做结构与语义校验；能不能真的导入成 CryptoKey 由 {@link importCheck} 负责。
 */
export function validateJwk(jwk: unknown, algorithm: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) {
    return [{ field: "public_key_jwk", message: "必须是一个 JWK 对象" }];
  }
  const key = jwk as Record<string, unknown>;

  if (JSON.stringify(key).length > MAX_JWK_LEN) {
    errors.push({ field: "public_key_jwk", message: `太长（上限 ${MAX_JWK_LEN} 字符）` });
  }

  // 私钥字段 —— 最先查，报错信息也要说清楚后果
  const leaked = PRIVATE_KEY_FIELDS.filter((f) => key[f] !== undefined);
  if (leaked.length > 0) {
    return [
      {
        field: "public_key_jwk",
        message:
          `这是**私钥**，不是公钥（含 ${leaked.join(" / ")} 字段）。` +
          `请只提交公钥部分。如果它已经被贴到过别处，请当作已泄露并重新生成密钥对。`,
      },
    ];
  }

  if (!KEY_ALGORITHMS.includes(algorithm as KeyAlgorithm)) {
    errors.push({
      field: "algorithm",
      message: `只支持 ${KEY_ALGORITHMS.join(" / ")}`,
    });
    return errors;
  }

  // JWK 自带的 alg 不能和声明的算法打架
  if (key.alg !== undefined && key.alg !== algorithm) {
    errors.push({
      field: "public_key_jwk",
      message: `JWK 的 alg 是 ${String(key.alg)}，与声明的 ${algorithm} 不一致`,
    });
  }

  // use / key_ops 若给了，必须是验签用途
  if (key.use !== undefined && key.use !== "sig") {
    errors.push({ field: "public_key_jwk", message: `JWK 的 use 必须是 "sig"` });
  }
  if (key.key_ops !== undefined) {
    const ops = Array.isArray(key.key_ops) ? key.key_ops.map(String) : [];
    if (!ops.includes("verify")) {
      errors.push({ field: "public_key_jwk", message: `JWK 的 key_ops 必须包含 "verify"` });
    }
  }

  if (algorithm === "ES256") {
    if (key.kty !== "EC") {
      errors.push({ field: "public_key_jwk", message: `ES256 要求 kty 为 "EC"` });
    }
    if (key.crv !== "P-256") {
      errors.push({ field: "public_key_jwk", message: `ES256 要求 crv 为 "P-256"` });
    }
    for (const f of ["x", "y"]) {
      if (typeof key[f] !== "string" || !key[f]) {
        errors.push({ field: "public_key_jwk", message: `EC 公钥缺少 ${f}` });
      }
    }
  } else {
    if (key.kty !== "RSA") {
      errors.push({ field: "public_key_jwk", message: `RS256 要求 kty 为 "RSA"` });
    }
    for (const f of ["n", "e"]) {
      if (typeof key[f] !== "string" || !key[f]) {
        errors.push({ field: "public_key_jwk", message: `RSA 公钥缺少 ${f}` });
      }
    }
    // n 是 base64url 的模数；2048 位 ≈ 342 字符。低于这个数就是弱密钥。
    if (typeof key.n === "string" && key.n.length < 342) {
      errors.push({
        field: "public_key_jwk",
        message: "RSA 模数不足 2048 位，太弱",
      });
    }
  }

  return errors;
}

/**
 * 真的把 JWK 导入一次，确认 WebCrypto 认它。
 *
 * 光看字段齐不齐是不够的：坐标不在曲线上、base64url 长度不对之类的问题
 * 只有导入时才暴露。不在这里挡住的话，错误会推迟到客户端第一次取 token
 * 才出现，而那时的报错是"签名无效"，指向完全错误的方向。
 */
export async function importCheck(
  jwk: Record<string, unknown>,
  algorithm: KeyAlgorithm,
): Promise<string | null> {
  const params =
    algorithm === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

  try {
    await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["verify"] } as JsonWebKey, params, false, [
      "verify",
    ]);
    return null;
  } catch (err) {
    return `WebCrypto 无法导入这个公钥：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 校验 key_id。 */
export function validateKeyId(keyId: unknown): ValidationError[] {
  if (keyId === undefined || keyId === null || keyId === "") {
    return []; // 允许不给，由服务端生成
  }
  if (typeof keyId !== "string") {
    return [{ field: "key_id", message: "必须是字符串" }];
  }
  if (keyId.length > MAX_KEY_ID_LEN) {
    return [{ field: "key_id", message: `太长（上限 ${MAX_KEY_ID_LEN} 字符）` }];
  }
  // kid 会原样出现在 JWT header 里，限制成保守的字符集
  if (!/^[A-Za-z0-9._~-]+$/.test(keyId)) {
    return [{ field: "key_id", message: "只允许字母、数字与 . _ ~ -" }];
  }
  return [];
}

/** 数据库行 → 对外的 ClientKey。 */
export function rowToClientKey(row: Record<string, unknown>): ClientKey {
  let jwk: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.public_key_jwk ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) jwk = parsed;
  } catch {
    // 历史数据可能不是合法 JSON —— 不要因此让整个列表接口 500
    jwk = {};
  }

  return {
    client_id: String(row.client_id),
    key_id: String(row.key_id),
    algorithm: (row.algorithm as KeyAlgorithm) || "ES256",
    status: (row.status as KeyStatus) || "active",
    created_at: Number(row.created_at),
    public_key_jwk: jwk,
  };
}

/** 确认应用存在且属于该 owner。不属于就当作不存在。 */
async function assertOwned(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
): Promise<boolean> {
  return (await getApplication(db, clientId, ownerUserId)) !== null;
}

/** 列出某个应用注册的全部公钥。@returns null 表示应用不存在或不属于该用户 */
export async function listClientKeys(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
): Promise<ClientKey[] | null> {
  if (!(await assertOwned(db, clientId, ownerUserId))) return null;

  const result = await db
    .prepare("SELECT * FROM client_keys WHERE client_id = ? ORDER BY created_at DESC")
    .bind(clientId)
    .all();

  return (result.results ?? []).map((row) => rowToClientKey(row as Record<string, unknown>));
}

export type AddKeyResult =
  | { ok: true; key: ClientKey }
  | { ok: false; notFound: true }
  | { ok: false; errors: ValidationError[] };

/**
 * 注册一个公钥。
 *
 * key_id 可以由调用方指定（要和客户端 JWT header 里的 kid 对上），
 * 不给就服务端生成一个。
 */
export async function addClientKey(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
  input: { public_key_jwk?: unknown; algorithm?: unknown; key_id?: unknown },
): Promise<AddKeyResult> {
  if (!(await assertOwned(db, clientId, ownerUserId))) {
    return { ok: false, notFound: true };
  }

  const algorithm = (input.algorithm as string) || "ES256";
  const errors = [...validateKeyId(input.key_id), ...validateJwk(input.public_key_jwk, algorithm)];
  if (errors.length > 0) return { ok: false, errors };

  const jwk = input.public_key_jwk as Record<string, unknown>;
  const importError = await importCheck(jwk, algorithm as KeyAlgorithm);
  if (importError) {
    return { ok: false, errors: [{ field: "public_key_jwk", message: importError }] };
  }

  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM client_keys WHERE client_id = ?")
    .bind(clientId)
    .first();
  if (Number(existing?.n ?? 0) >= MAX_KEYS_PER_APP) {
    return {
      ok: false,
      errors: [
        { field: "key_id", message: `公钥数量已达上限（${MAX_KEYS_PER_APP}），请先删除不用的` },
      ],
    };
  }

  // kid 取值优先级：显式传入 > JWK 自带 > 服务端生成
  const keyId =
    (typeof input.key_id === "string" && input.key_id) ||
    (typeof jwk.kid === "string" && jwk.kid) ||
    `key_${generateId(16)}`;

  const kidErrors = validateKeyId(keyId);
  if (kidErrors.length > 0) return { ok: false, errors: kidErrors };

  const duplicate = await db
    .prepare("SELECT key_id FROM client_keys WHERE client_id = ? AND key_id = ?")
    .bind(clientId, keyId)
    .first();
  if (duplicate) {
    return {
      ok: false,
      errors: [{ field: "key_id", message: `key_id "${keyId}" 已存在，换一个或先删除旧的` }],
    };
  }

  // 存进去的 JWK 带上 kid，这样导出的 JWKS 直接可用
  const stored = { ...jwk, kid: keyId, alg: algorithm, use: "sig" };
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO client_keys (client_id, key_id, public_key_jwk, algorithm, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(clientId, keyId, JSON.stringify(stored), algorithm, now)
    .run();

  return {
    ok: true,
    key: {
      client_id: clientId,
      key_id: keyId,
      algorithm: algorithm as KeyAlgorithm,
      status: "active",
      created_at: now,
      public_key_jwk: stored,
    },
  };
}

/**
 * 改公钥状态（active ⇄ revoked）。
 *
 * 撤销而不是删除，是为了留下"这个 kid 曾经存在过"的记录 ——
 * 排查"客户端说签名对了，服务端说找不到 key"时，这个区别很关键。
 *
 * @returns 更新后的公钥；不存在或不属于该用户时返回 null
 */
export async function setClientKeyStatus(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
  keyId: string,
  status: KeyStatus,
): Promise<ClientKey | null> {
  if (!KEY_STATUSES.includes(status)) return null;
  if (!(await assertOwned(db, clientId, ownerUserId))) return null;

  const result = await db
    .prepare("UPDATE client_keys SET status = ? WHERE client_id = ? AND key_id = ?")
    .bind(status, clientId, keyId)
    .run();

  if (!result.meta?.changes) return null;

  const row = await db
    .prepare("SELECT * FROM client_keys WHERE client_id = ? AND key_id = ?")
    .bind(clientId, keyId)
    .first();

  return row ? rowToClientKey(row as Record<string, unknown>) : null;
}

/** 删除一个公钥。@returns 是否真的删掉了 */
export async function deleteClientKey(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
  keyId: string,
): Promise<boolean> {
  if (!(await assertOwned(db, clientId, ownerUserId))) return false;

  const result = await db
    .prepare("DELETE FROM client_keys WHERE client_id = ? AND key_id = ?")
    .bind(clientId, keyId)
    .run();

  return Boolean(result.meta?.changes);
}
