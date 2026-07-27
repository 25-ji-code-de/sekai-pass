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


// ID Token Generation and Validation
// Implements OpenID Connect ID Token functionality

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { signJWT, verifyJWT, decodeJWT } from "./jwt.ts";
import { getCurrentSigningKey, getSigningKeyByKid } from "./keys.ts";
import { getClaimsForScope } from "./oidc-scope.ts";
import { SCOPES, parseScopes } from "./scope.ts";

/**
 * `email_verified` 的值。
 *
 * ── 为什么是 false ────────────────────────────────────────────────
 *
 * 本服务**没有任何邮箱验证流程**：注册时只要求邮箱在库里唯一，不发确认信，
 * 库里也没有记录验证状态的字段。也就是说，谁都可以拿别人的邮箱注册。
 *
 * 这里此前硬编码 `true`，注释写的是 `// Assuming verified` —— 但 OIDC Core
 * §5.1 对这个 claim 的定义是「True 当且仅当该邮箱**已被验证**」。发 `true`
 * 就是在向依赖方断言一件我们从没做过的事。
 *
 * 后果不是抽象的：很多接入方按「邮箱已验证」做账号关联（「这个邮箱已经有
 * 账号了，帮你合并」）。于是攻击者用受害者的邮箱在这里注册，去登录那个接入方，
 * 就接管了受害者在**那边**的账号。开放平台上线后接入方不再只有我们自己，
 * 这条尤其要紧。
 *
 * 改成 `false` 是**如实陈述**，不是降级。真要发 `true`，得先有验证流程 ——
 * 那是产品决定，不是这个常量的事。
 */
export const EMAIL_VERIFIED = false;

/**
 * `acr`（Authentication Context Class Reference）的值。
 *
 * ── 为什么不是 InCommon Silver ────────────────────────────────────
 *
 * 这里此前无条件发 `urn:mace:incommon:iap:silver`。
 *
 * InCommon 的 Identity Assurance Profile「Silver」不是一个形容词，是一套
 * **有具体要求**的等级：要求对申请人做身份核验（比对政府证件或等效手段）、
 * 对凭据强度与生命周期有规定、还要可审计。
 *
 * 本服务的实际情况是：自助注册，填一个**连确认信都不发**的邮箱，加一个密码。
 * 这离 Silver 差得很远 —— 发这个值等于替一套我们没有的流程背书。
 *
 * OIDC Core §2 对 `acr` 的说明里给了确切的写法：
 *
 *   > The value "0" indicates the End-User authentication did not meet the
 *   > requirements of ISO/IEC 29115 level 1.
 *
 * 自助注册 + 未验证邮箱正是这种情况，所以发 `"0"`。
 *
 * `amr: ["pwd"]` 保持不变 —— 那一条是**准确**的：确实是密码认证。
 *
 * 什么时候能改：真的做了身份核验（或至少邮箱验证 + MFA）之后，
 * 按实际达到的等级发，并在 discovery 里声明 `acr_values_supported`。
 */
export const ACR = "0";

export interface IDTokenClaims {
  // Required claims
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;

  // Optional claims
  auth_time?: number;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  bio?: string;
  email?: string;
  email_verified?: boolean;
  acr?: string;
  amr?: string[];
}

/**
 * Build ID token claims from user data
 */
export function buildIDTokenClaims(
  user: any,
  clientId: string,
  issuer: string,
  nonce: string | null,
  authTime: number,
  scope: string
): IDTokenClaims {
  const now = Math.floor(Date.now() / 1000);

  const claims: IDTokenClaims = {
    iss: issuer,
    sub: user.id,
    aud: clientId,
    exp: now + 3600, // 1 hour
    iat: now,
    auth_time: Math.floor(authTime / 1000)
  };

  // Add nonce if provided
  if (nonce) {
    claims.nonce = nonce;
  }

  // Add claims based on scope
  /*
   * ── 披露用 `granted.includes(...)`，不用 `hasScopes` ─────────────
   *
   * `hasScopes` 里有一条「admin 一票通过」：
   *
   *     if (grantedScopes.includes(SCOPES.ADMIN)) return true;
   *
   * 那是给**授权判断**用的（「这个 token 能不能做 X」），对**披露判断**
   * （「这个 token 里该放什么」）是错的。用它的后果是：只申请 `admin` 的
   * 客户端，ID Token 里白拿到 email / name / bio / picture ——
   * 它既没申请 `profile` 也没申请 `email`，用户在授权页上也没看到这两项。
   *
   * 而意图本来就写在代码里，`oidc-scope.ts` 的 `getClaimsForScope`：
   *
   *     // applications and admin scopes don't add claims to ID token
   *
   * 那个函数照做了，这里没有 —— 于是同一个问题有两个答案，
   * 而 discovery 对外声称的是那一个。
   */
  const granted = parseScopes(scope);

  if (granted.includes(SCOPES.PROFILE)) {
    claims.name = user.display_name;
    claims.preferred_username = user.username;
    if (user.avatar_url) {
      claims.picture = user.avatar_url;
    }
    if (user.bio) {
      claims.bio = user.bio;
    }
  }

  if (granted.includes(SCOPES.EMAIL)) {
    claims.email = user.email;
    claims.email_verified = EMAIL_VERIFIED;
  }

  // Add authentication context
  claims.acr = ACR;
  claims.amr = ["pwd"]; // Password authentication

  return claims;
}

/**
 * Generate ID token
 */
export async function generateIDToken(
  db: D1Database,
  kv: KVNamespace,
  user: any,
  clientId: string,
  nonce: string | null,
  authTime: number,
  scope: string,
  issuer: string,
  encryptionKey: string
): Promise<string> {
  // Get current signing key
  const signingKey = await getCurrentSigningKey(db, kv, encryptionKey);

  if (!signingKey) {
    throw new Error("No signing key available");
  }

  // Build claims
  const claims = buildIDTokenClaims(
    user,
    clientId,
    issuer,
    nonce,
    authTime,
    scope
  );

  // Sign JWT
  return await signJWT(claims, signingKey.privateKeyJWK, signingKey.kid);
}

/**
 * Validate ID token
 */
export async function validateIDToken(
  token: string,
  db: D1Database,
  expectedIssuer: string,
  expectedAudience: string
): Promise<{ valid: boolean; claims?: IDTokenClaims; error?: string }> {
  // Decode token
  const decoded = decodeJWT(token);

  if (!decoded) {
    return { valid: false, error: "Invalid token format" };
  }

  // Get signing key
  const kid = decoded.header.kid;
  if (!kid) {
    return { valid: false, error: "Missing kid in token header" };
  }

  const publicKey = await getSigningKeyByKid(db, kid);
  if (!publicKey) {
    return { valid: false, error: "Unknown signing key" };
  }

  // Verify signature
  const signatureValid = await verifyJWT(token, publicKey);
  if (!signatureValid) {
    return { valid: false, error: "Invalid signature" };
  }

  const claims = decoded.payload as IDTokenClaims;

  // Validate issuer
  if (claims.iss !== expectedIssuer) {
    return { valid: false, error: "Invalid issuer" };
  }

  // Validate audience
  if (claims.aud !== expectedAudience) {
    return { valid: false, error: "Invalid audience" };
  }

  // Validate expiration
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    return { valid: false, error: "Token expired" };
  }

  // Validate issued at (not in future)
  if (claims.iat > now + 60) { // Allow 60 second clock skew
    return { valid: false, error: "Token issued in future" };
  }

  return { valid: true, claims };
}
