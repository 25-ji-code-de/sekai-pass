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
 * OAuth 应用的自助管理（开放平台）。
 *
 * 在这之前 applications 表**没有任何代码写入** —— 注册一个新的 OAuth 应用
 * 只能手工往库里 INSERT。
 *
 * 权限模型：应用归属于创建者（owner_user_id）。所有读写都按 owner 过滤，
 * 拿到别人的 client_id 也改不了别人的应用。
 */

import type { D1Database } from "@cloudflare/workers-types";
import { generateId } from "./password.ts";

/** redirect_uri 数量上限 —— 防止把一整本字典塞进一个应用。 */
export const MAX_REDIRECT_URIS = 10;
/** 单个 redirect_uri 长度上限。 */
export const MAX_REDIRECT_URI_LEN = 2048;
export const MAX_NAME_LEN = 64;
export const MAX_DESCRIPTION_LEN = 500;
/** 单个用户能创建的应用数量上限。 */
export const MAX_APPS_PER_USER = 20;

/** 支持的客户端认证方式。 */
export const AUTH_METHODS = ["none", "private_key_jwt"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export interface Application {
  id: string;
  name: string;
  client_id: string;
  redirect_uris: string[];
  token_endpoint_auth_method: AuthMethod;
  description: string | null;
  homepage_url: string | null;
  owner_user_id: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ApplicationInput {
  name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  description?: unknown;
  homepage_url?: unknown;
}

/**
 * 校验 redirect_uri。
 *
 * OAuth 2.1 的要求：必须是绝对 URI、不能带 fragment。
 * http 只允许 loopback（本地开发），其余必须 https —— 与 index.ts 里
 * 授权端点的校验保持一致。
 */
export function validateRedirectUri(uri: string): string | null {
  if (typeof uri !== "string" || uri.length === 0) {
    return "不能为空";
  }
  if (uri.length > MAX_REDIRECT_URI_LEN) {
    return `太长（上限 ${MAX_REDIRECT_URI_LEN} 字符）`;
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return "不是合法的绝对 URI";
  }

  if (parsed.hash) {
    return "不能包含 fragment（# 之后的部分）";
  }

  if (parsed.protocol === "https:") {
    return null;
  }

  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    return isLoopback ? null : "http 只允许 localhost / 127.0.0.1（其余必须用 https）";
  }

  // 自定义 scheme（原生 App 回调）也放行，但要求形如 com.example.app:/callback
  if (/^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol) && parsed.protocol.includes(".")) {
    return null;
  }

  return "只支持 https、loopback http、或带点号的自定义 scheme";
}

/** 校验创建/更新应用的入参。返回空数组表示通过。 */
export function validateApplicationInput(
  input: ApplicationInput,
  { partial = false }: { partial?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];

  const nameGiven = input.name !== undefined;
  if (!partial || nameGiven) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      errors.push({ field: "name", message: "应用名不能为空" });
    } else if (input.name.length > MAX_NAME_LEN) {
      errors.push({ field: "name", message: `应用名太长（上限 ${MAX_NAME_LEN} 字符）` });
    }
  }

  const urisGiven = input.redirect_uris !== undefined;
  if (!partial || urisGiven) {
    if (!Array.isArray(input.redirect_uris)) {
      errors.push({ field: "redirect_uris", message: "必须是数组" });
    } else if (input.redirect_uris.length === 0) {
      errors.push({ field: "redirect_uris", message: "至少要有一个回调地址" });
    } else if (input.redirect_uris.length > MAX_REDIRECT_URIS) {
      errors.push({
        field: "redirect_uris",
        message: `最多 ${MAX_REDIRECT_URIS} 个`,
      });
    } else {
      input.redirect_uris.forEach((uri, i) => {
        const error = validateRedirectUri(uri as string);
        if (error) {
          errors.push({ field: `redirect_uris[${i}]`, message: error });
        }
      });
      const unique = new Set(input.redirect_uris as string[]);
      if (unique.size !== input.redirect_uris.length) {
        errors.push({ field: "redirect_uris", message: "有重复项" });
      }
    }
  }

  if (input.token_endpoint_auth_method !== undefined) {
    if (!AUTH_METHODS.includes(input.token_endpoint_auth_method as AuthMethod)) {
      errors.push({
        field: "token_endpoint_auth_method",
        message: `只支持 ${AUTH_METHODS.join(" / ")}`,
      });
    }
  }

  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") {
      errors.push({ field: "description", message: "必须是字符串" });
    } else if (input.description.length > MAX_DESCRIPTION_LEN) {
      errors.push({
        field: "description",
        message: `太长（上限 ${MAX_DESCRIPTION_LEN} 字符）`,
      });
    }
  }

  if (input.homepage_url !== undefined && input.homepage_url !== null && input.homepage_url !== "") {
    if (typeof input.homepage_url !== "string") {
      errors.push({ field: "homepage_url", message: "必须是字符串" });
    } else {
      try {
        const parsed = new URL(input.homepage_url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          errors.push({ field: "homepage_url", message: "只支持 http / https" });
        }
      } catch {
        errors.push({ field: "homepage_url", message: "不是合法的 URL" });
      }
    }
  }

  return errors;
}

/** 数据库行 → 对外的 Application（redirect_uris 从 JSON 解开）。 */
export function rowToApplication(row: Record<string, unknown>): Application {
  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(String(row.redirect_uris ?? "[]"));
    redirectUris = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    // 历史数据可能是逗号分隔的
    redirectUris = String(row.redirect_uris ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    id: String(row.id),
    name: String(row.name),
    client_id: String(row.client_id),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: (row.token_endpoint_auth_method as AuthMethod) || "none",
    description: (row.description as string) ?? null,
    homepage_url: (row.homepage_url as string) ?? null,
    owner_user_id: (row.owner_user_id as string) ?? null,
    created_at: Number(row.created_at),
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
  };
}

/** 列出某个用户拥有的全部应用。 */
export async function listApplications(db: D1Database, ownerUserId: string): Promise<Application[]> {
  const result = await db
    .prepare(
      "SELECT * FROM applications WHERE owner_user_id = ? ORDER BY created_at DESC",
    )
    .bind(ownerUserId)
    .all();

  return (result.results ?? []).map((row) => rowToApplication(row as Record<string, unknown>));
}

/**
 * 取单个应用。
 *
 * **必须同时按 owner 过滤** —— 否则知道 client_id 就能读别人的应用。
 */
export async function getApplication(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
): Promise<Application | null> {
  const row = await db
    .prepare("SELECT * FROM applications WHERE client_id = ? AND owner_user_id = ?")
    .bind(clientId, ownerUserId)
    .first();

  return row ? rowToApplication(row as Record<string, unknown>) : null;
}

/** 创建应用。client_id / client_secret 由服务端生成，不接受调用方指定。 */
export async function createApplication(
  db: D1Database,
  ownerUserId: string,
  input: ApplicationInput,
): Promise<{ application: Application; client_secret: string }> {
  const now = Date.now();
  const id = generateId(24);
  const clientId = `app_${generateId(24)}`;
  const clientSecret = generateId(48);
  const authMethod = (input.token_endpoint_auth_method as AuthMethod) ?? "none";

  await db
    .prepare(
      `INSERT INTO applications
         (id, name, client_id, client_secret, redirect_uris, created_at,
          owner_user_id, token_endpoint_auth_method, description, homepage_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      String(input.name).trim(),
      clientId,
      clientSecret,
      JSON.stringify(input.redirect_uris),
      now,
      ownerUserId,
      authMethod,
      (input.description as string) || null,
      (input.homepage_url as string) || null,
      now,
    )
    .run();

  return {
    application: rowToApplication({
      id,
      name: String(input.name).trim(),
      client_id: clientId,
      redirect_uris: JSON.stringify(input.redirect_uris),
      created_at: now,
      owner_user_id: ownerUserId,
      token_endpoint_auth_method: authMethod,
      description: (input.description as string) || null,
      homepage_url: (input.homepage_url as string) || null,
      updated_at: now,
    }),
    client_secret: clientSecret,
  };
}

/**
 * 更新应用。只更新传入的字段。
 *
 * `client_id` / `client_secret` / `owner_user_id` **不可通过本接口修改**。
 * @returns 更新后的应用；不存在或不属于该用户时返回 null
 */
export async function updateApplication(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
  input: ApplicationInput,
): Promise<Application | null> {
  const existing = await getApplication(db, clientId, ownerUserId);
  if (!existing) return null;

  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    sets.push("name = ?");
    values.push(String(input.name).trim());
  }
  if (input.redirect_uris !== undefined) {
    sets.push("redirect_uris = ?");
    values.push(JSON.stringify(input.redirect_uris));
  }
  if (input.token_endpoint_auth_method !== undefined) {
    sets.push("token_endpoint_auth_method = ?");
    values.push(input.token_endpoint_auth_method);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    values.push((input.description as string) || null);
  }
  if (input.homepage_url !== undefined) {
    sets.push("homepage_url = ?");
    values.push((input.homepage_url as string) || null);
  }

  if (sets.length === 0) return existing;

  sets.push("updated_at = ?");
  values.push(Date.now());

  await db
    .prepare(
      `UPDATE applications SET ${sets.join(", ")} WHERE client_id = ? AND owner_user_id = ?`,
    )
    .bind(...values, clientId, ownerUserId)
    .run();

  return getApplication(db, clientId, ownerUserId);
}

/**
 * 删除应用，连带清掉它签发过的 token 与注册的公钥。
 *
 * 不做级联清理的话，应用删了但它的 access token 还能继续用。
 */
export async function deleteApplication(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
): Promise<boolean> {
  const existing = await getApplication(db, clientId, ownerUserId);
  if (!existing) return false;

  await db.batch([
    db.prepare("DELETE FROM access_tokens WHERE client_id = ?").bind(clientId),
    db.prepare("DELETE FROM refresh_tokens WHERE client_id = ?").bind(clientId),
    db.prepare("DELETE FROM auth_codes WHERE client_id = ?").bind(clientId),
    db.prepare("DELETE FROM client_keys WHERE client_id = ?").bind(clientId),
    db
      .prepare("DELETE FROM applications WHERE client_id = ? AND owner_user_id = ?")
      .bind(clientId, ownerUserId),
  ]);

  return true;
}

/** 轮换 client_secret。@returns 新密钥；应用不存在或不属于该用户时返回 null */
export async function rotateClientSecret(
  db: D1Database,
  clientId: string,
  ownerUserId: string,
): Promise<string | null> {
  const existing = await getApplication(db, clientId, ownerUserId);
  if (!existing) return null;

  const secret = generateId(48);
  await db
    .prepare("UPDATE applications SET client_secret = ?, updated_at = ? WHERE client_id = ? AND owner_user_id = ?")
    .bind(secret, Date.now(), clientId, ownerUserId)
    .run();

  return secret;
}

/** 该用户是否已达到应用数量上限。 */
export async function isAtAppLimit(db: D1Database, ownerUserId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE owner_user_id = ?")
    .bind(ownerUserId)
    .first();
  return Number(row?.n ?? 0) >= MAX_APPS_PER_USER;
}
