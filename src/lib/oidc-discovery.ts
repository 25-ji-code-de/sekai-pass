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


// OpenID Connect Discovery Metadata
// Generates OIDC discovery document per OpenID Connect Discovery 1.0

import { SCOPES } from "./scope.ts";

/**
 * 两个 well-known 端点描述的是**同一台服务器**：
 *
 *   /.well-known/oauth-authorization-server  （RFC 8414）
 *   /.well-known/openid-configuration        （OIDC Discovery 1.0）
 *
 * 此前它们是两份手工维护的字面量 —— 一份在这里，一份直接写在 index.ts 的
 * 路由里。于是线上这两份文档在 5 个字段上互相矛盾，其中包括
 * `scopes_supported` 里有**两个 openid**（这里写了 `["openid", ...SCOPES]`，
 * 而 SCOPES 本身就含 openid）。
 *
 * 现在共有部分只有一份来源，OIDC 文档在它之上追加自己特有的字段。
 */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_signing_alg_values_supported: string[];
  scopes_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  service_documentation?: string;
  ui_locales_supported?: string[];
  require_pushed_authorization_requests: boolean;
  require_request_uri_registration: boolean;
}

/** OIDC Discovery 1.0 在 RFC 8414 之上多要求的那几个字段。 */
export interface OIDCMetadata extends AuthorizationServerMetadata {
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  claims_supported: string[];
}

/**
 * RFC 8414 授权服务器元数据 —— 两个 well-known 端点共有的那一份。
 */
export function generateAuthorizationServerMetadata(
  baseUrl: string
): AuthorizationServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,

    // Response types
    response_types_supported: ["code"],

    // Grant types
    grant_types_supported: ["authorization_code", "refresh_token"],

    // Signing algorithms（客户端做 private_key_jwt 时可用的签名算法）
    token_endpoint_auth_signing_alg_values_supported: ["ES256", "RS256"],

    /*
     * SCOPES 本身就含 openid —— 此前这里写成 `["openid", ...Object.values(SCOPES)]`，
     * 于是线上文档里 openid 出现两次。
     */
    scopes_supported: Object.values(SCOPES),

    // Authentication methods
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    revocation_endpoint_auth_methods_supported: ["none"],

    // PKCE - OAuth 2.1: Only S256 method is supported
    code_challenge_methods_supported: ["S256"],

    // Optional metadata
    service_documentation: `${baseUrl}/docs`,
    ui_locales_supported: ["zh-CN", "en-US"],

    // OAuth 2.1: PKCE is mandatory
    require_pushed_authorization_requests: false,
    require_request_uri_registration: false
  };
}

/**
 * Generate OIDC discovery metadata
 */
export function generateOIDCMetadata(baseUrl: string): OIDCMetadata {
  return {
    ...generateAuthorizationServerMetadata(baseUrl),

    // Subject types
    subject_types_supported: ["public"],

    // Signing algorithms（本服务签 ID Token 用的算法）
    id_token_signing_alg_values_supported: ["ES256", "RS256"],

    // Claims
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "name",
      "preferred_username",
      "picture",
      "bio",
      "email",
      "email_verified",
      "acr",
      "amr"
    ]
  };
}
