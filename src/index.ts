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

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { initializeLucia } from "./lib/auth.ts";
import { generateId } from "./lib/password.ts";
import { verifyPKCE, validateCodeChallenge, validateCodeVerifier } from "./lib/pkce.ts";
import { issueTokens, validateAccessToken, refreshAccessToken, revokeRefreshToken, revokeAllUserTokens } from "./lib/tokens.ts";
import { validateScopeParameter, formatScopes, filterUserData, SCOPES, hasScopes } from "./lib/scope.ts";
import { isOIDCRequest } from "./lib/oidc-scope.ts";
import { generateIDToken, EMAIL_VERIFIED } from "./lib/id-token.ts";
import {
  generateOIDCMetadata,
  generateAuthorizationServerMetadata
} from "./lib/oidc-discovery.ts";
import { getOrCreatePublicKeys, checkAndRotateKeys } from "./lib/keys.ts";
import { bearerChallenge } from "./lib/bearer-challenge.ts";
import { revokeToken } from "./lib/revoke.ts";
import { authenticateClient } from "./lib/client-auth.ts";
import * as html from "./lib/html.ts";
import { apiRouter } from "./lib/api.ts";

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
  HCAPTCHA_SECRET_KEY?: string;
  HCAPTCHA_SITE_KEY?: string;
  KEY_ENCRYPTION_SECRET: string;
  POW_FAST_COUNTRIES?: string;
  ASSETS: Fetcher;
};

type Variables = {
  user: any | null;
  session: any | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ============================================
// Security Helper Functions
// ============================================

/**
 * Check if URL is a loopback address (localhost)
 * OAuth 2.1 allows HTTP for loopback interfaces only
 */
function isLoopback(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'localhost' ||
           hostname === '127.0.0.1' ||
           hostname === '[::1]' ||
           hostname.startsWith('127.') ||
           hostname.startsWith('[::ffff:127.');
  } catch {
    return false;
  }
}

/**
 * Enforce HTTPS for OAuth endpoints (except loopback)
 * OAuth 2.1 requirement: All OAuth protocol URLs MUST use HTTPS
 */
function enforceHTTPS(c: any): Response | null {
  const requestUrl = new URL(c.req.url);
  if (requestUrl.protocol === 'http:' && !isLoopback(c.req.url)) {
    return c.json({
      error: "invalid_request",
      error_description: "HTTPS is required for OAuth endpoints"
    }, 400);
  }
  return null;
}

/**
 * Parse redirect URIs from database (supports both JSON array and comma-separated string)
 * Handles legacy comma-separated format and modern JSON array format
 */
function parseRedirectUris(redirectUris: string): string[] {
  try {
    // Try parsing as JSON array first
    const parsed = JSON.parse(redirectUris);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    // If it's a JSON string (not array), treat as single URI
    return [String(parsed)];
  } catch {
    // Fallback to comma-separated format
    return redirectUris.split(',').map(uri => uri.trim()).filter(uri => uri.length > 0);
  }
}

/**
 * 安全响应头。
 *
 * 本仓是 Worker 不是 Pages，没有 _headers 文件 —— 在这次加上之前，
 * **整个 SSO 一个安全头都没有**。授权同意页因此可以被 iframe 嵌套，
 * 攻击者可以透明覆盖诱导用户点「允许访问」（点击劫持）。
 *
 * 分两条推进，与四个静态站的做法一致：
 *   Content-Security-Policy            —— 只放零破坏风险的指令，强制生效
 *   Content-Security-Policy-Report-Only —— 完整策略，先收集违规数据
 *
 * index.html（SPA 入口）没有任何内联 script/style，所以完整策略里
 * script-src 不需要 'unsafe-inline'；docs.html 有内联，Report-Only
 * 阶段会把它报出来，届时再决定是外置还是给 docs 单独放宽。
 */
const CSP_ENFORCED = [
  "object-src 'none'",
  "base-uri 'self'",
  /*
   * ── form-action 不放在强制 CSP 里 ─────────────────────────────
   *
   * OAuth 授权页的表单 POST 到 /oauth/authorize 后，服务端返回 302
   * redirect 到第三方域名（redirect_uri）。`form-action 'self'` 会阻止
   * 这个跨域 redirect —— 浏览器不会跳转，也没有明显的错误提示。
   *
   * form-action 的目的是防止表单被劫持到恶意 URL，但授权页的
   * redirect_uri 在 GET 和 POST 两个阶段都与服务端注册的值比对过了，
   * 不依赖 CSP 做这个检查。
   */
  "frame-ancestors 'none'",
].join('; ');

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // Turnstile and hCaptcha scripts plus challenge frames
  "script-src 'self' https://challenges.cloudflare.com https://js.hcaptcha.com",
  "frame-src https://challenges.cloudflare.com https://*.hcaptcha.com",
  "connect-src 'self' https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com https://storage.nightcord.de5.net https://upload.nightcord.de5.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // 头像来自对象存储
  "img-src 'self' data: https://assets.nightcord.de5.net https://r2.nightcord.de5.net",
  "object-src 'none'",
  "base-uri 'self'",
  // form-action 同样不放这里 —— 见 CSP_ENFORCED 上方的说明。留在 Report-Only
  // 里也不合适：它现在不拦截，但转正那天会用同一个方式打断授权跳转。
  "frame-ancestors 'none'",
].join('; ');

app.use("*", async (c, next) => {
  await next();

  // 点击劫持防护 —— 对同意页尤其关键，它一个误点就等于批准了授权
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // 不带 includeSubDomains：只约束本主机，避免影响其它 *.nightcord.de5.net
  c.header("Strict-Transport-Security", "max-age=31536000");
  c.header("Content-Security-Policy", CSP_ENFORCED);
  c.header("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY);
});

// CORS middleware for API and OAuth endpoints
app.use("/api/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: false,
}));

app.use("/oauth/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  /*
   * WWW-Authenticate 必须列进 exposeHeaders，否则**浏览器里的客户端读不到它**。
   *
   * 跨域响应默认只暴露 CORS 安全清单里那几个头，其余一律被 fetch 屏蔽 ——
   * 服务端发了、DevTools 里也看得见，但 `res.headers.get(...)` 返回 null。
   * 那等于白发：本服务的客户端全是浏览器里的 SPA。
   */
  exposeHeaders: ["Content-Length", "WWW-Authenticate"],
  maxAge: 600,
  credentials: false,
}));

// CORS middleware for .well-known endpoints (OIDC Discovery, JWKS)
app.use("/.well-known/*", cors({
  origin: "*",
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["Content-Type"],
  exposeHeaders: ["Content-Length", "Cache-Control"],
  maxAge: 3600,  // 1 hour cache for preflight
  credentials: false,
}));

// Mount API router
app.route("/api", apiRouter);

// Middleware to get current user (for traditional OAuth flow)
app.use("/oauth/*", async (c, next) => {
  const lucia = initializeLucia(c.env.DB);
  const sessionId = getCookie(c, lucia.sessionCookieName);

  if (!sessionId) {
    c.set("user", null);
    c.set("session", null);
    return next();
  }

  const { session, user } = await lucia.validateSession(sessionId);

  if (session && session.fresh) {
    const sessionCookie = lucia.createSessionCookie(session.id);
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
  }

  if (!session) {
    const sessionCookie = lucia.createBlankSessionCookie();
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
  }

  c.set("user", user);
  c.set("session", session);
  await next();
});

// ============================================
// Traditional OAuth 2.0 Endpoints (保留用于第三方接入)
// ============================================

// OAuth Discovery Endpoint (RFC 8414)
app.get("/.well-known/oauth-authorization-server", async (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json(generateAuthorizationServerMetadata(baseUrl));
});

// OpenID Connect Discovery Endpoint
app.get("/.well-known/openid-configuration", async (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json(generateOIDCMetadata(baseUrl));
});

// JWKS (JSON Web Key Set) Endpoint
app.get("/.well-known/jwks.json", async (c) => {
  // Ensure a key exists before caching: the response below is cached for an
  // hour, so publishing an empty set would strand every relying party for that
  // long even after a key becomes available.
  const publicKeys = await getOrCreatePublicKeys(
    c.env.DB,
    c.env.KV,
    c.env.KEY_ENCRYPTION_SECRET
  );
  return c.json({
    keys: publicKeys
  }, 200, {
    "Cache-Control": "public, max-age=3600"  // Cache for 1 hour
  });
});

// OAuth authorization endpoint (traditional flow with HTML)
app.get("/oauth/authorize", async (c) => {
  // OAuth 2.1: Enforce HTTPS (except for loopback)
  const httpsError = enforceHTTPS(c);
  if (httpsError) return httpsError;

  const user = c.get("user");

  if (!user) {
    const params = new URLSearchParams(c.req.query());
    const redirectPath = `/oauth/authorize?${params.toString()}`;
    return c.redirect(`/login?redirect=${encodeURIComponent(redirectPath)}`);
  }

  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const responseType = c.req.query("response_type");
  const codeChallenge = c.req.query("code_challenge");
  const codeChallengeMethod = c.req.query("code_challenge_method") || "S256";
  const state = c.req.query("state");
  const scopeParam = c.req.query("scope");
  const nonce = c.req.query("nonce");

  if (!clientId || !redirectUri || responseType !== "code") {
    return c.text("Invalid request", 400);
  }

  // OAuth 2.1: PKCE is mandatory for all clients
  if (!codeChallenge) {
    return c.text("code_challenge is required (PKCE mandatory)", 400);
  }

  // OAuth 2.1: Only S256 method is allowed
  if (codeChallengeMethod !== "S256") {
    return c.text("Only S256 code_challenge_method is supported", 400);
  }

  if (!validateCodeChallenge(codeChallenge, codeChallengeMethod)) {
    return c.text("Invalid code_challenge", 400);
  }

  // Validate scope parameter
  const scopeValidation = validateScopeParameter(scopeParam);
  if (!scopeValidation.valid) {
    return c.text(scopeValidation.error || "Invalid scope", 400);
  }
  const requestedScopes = scopeValidation.scopes;

  const app = await c.env.DB.prepare(
    "SELECT * FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return c.text("Invalid client", 400);
  }

  const allowedUris = parseRedirectUris(app.redirect_uris as string);
  if (!allowedUris.includes(redirectUri)) {
    return c.text("Invalid redirect URI", 400);
  }

  // OAuth 2.1: redirect_uri must use HTTPS (except loopback)
  if (redirectUri.startsWith('http:') && !isLoopback(redirectUri)) {
    return c.text("redirect_uri must use HTTPS", 400);
  }

  return c.html(html.authorizePage(
    {
      name: app.name,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state: state,
      scope: formatScopes(requestedScopes),
      nonce: nonce
    },
    user
  ));
});

// OAuth authorization handler (traditional flow)
app.post("/oauth/authorize", async (c) => {
  // OAuth 2.1: Enforce HTTPS (except for loopback)
  const httpsError = enforceHTTPS(c);
  if (httpsError) return httpsError;

  const user = c.get("user");

  if (!user) {
    return c.redirect("/login");
  }

  try {
    const formData = await c.req.formData();
    const action = formData.get("action")?.toString();
    const clientId = formData.get("client_id")?.toString();
    const redirectUri = formData.get("redirect_uri")?.toString();
    const codeChallenge = formData.get("code_challenge")?.toString() || null;
    const codeChallengeMethod = formData.get("code_challenge_method")?.toString() || null;
    const state = formData.get("state")?.toString() || null;
    const scopeParam = formData.get("scope")?.toString() || null;
    const nonce = formData.get("nonce")?.toString() || null;

    if (!clientId || !redirectUri) {
      return c.text("Invalid request", 400);
    }

    // Re-validate redirect_uri against registered URIs (form data can be tampered)
    const postApp = await c.env.DB.prepare(
      "SELECT redirect_uris FROM applications WHERE client_id = ?"
    ).bind(clientId).first();

    if (!postApp) {
      return c.text("Invalid client", 400);
    }

    const postAllowedUris = parseRedirectUris(postApp.redirect_uris as string);
    if (!postAllowedUris.includes(redirectUri)) {
      return c.text("Invalid redirect URI", 400);
    }

    if (action === "deny") {
      const errorUrl = new URL(redirectUri);
      errorUrl.searchParams.set("error", "access_denied");
      if (state) {
        errorUrl.searchParams.set("state", state);
      }
      return c.redirect(errorUrl.toString());
    }

    // Validate and parse scope
    const scopeValidation = validateScopeParameter(scopeParam);
    if (!scopeValidation.valid) {
      return c.text(scopeValidation.error || "Invalid scope", 400);
    }
    const scope = formatScopes(scopeValidation.scopes);

    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const createdAt = Date.now();
    const authTime = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, created_at, code_challenge, code_challenge_method, state, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, clientId, redirectUri, expiresAt, createdAt, codeChallenge, codeChallengeMethod, state, scope).run();

    // Store OIDC auth data if this is an OIDC request
    if (isOIDCRequest(scope)) {
      await c.env.DB.prepare(
        "INSERT INTO oidc_auth_data (code, nonce, auth_time) VALUES (?, ?, ?)"
      ).bind(code, nonce, authTime).run();

      // Update user's last_auth_time (optional, ignore if column doesn't exist)
      try {
        await c.env.DB.prepare(
          "UPDATE users SET last_auth_time = ? WHERE id = ?"
        ).bind(authTime, user.id).run();
      } catch (error) {
        // Ignore error if last_auth_time column doesn't exist
      }
    }

    const successUrl = new URL(redirectUri);
    successUrl.searchParams.set("code", code);
    // OAuth 2.1: Include issuer parameter to prevent mix-up attacks
    successUrl.searchParams.set("iss", new URL(c.req.url).origin);
    if (state) {
      successUrl.searchParams.set("state", state);
    }
    return c.redirect(successUrl.toString());
  } catch (error) {
    console.error("OAuth authorize error:", error);
    return c.text("Internal Server Error", 500);
  }
});

// OAuth token endpoint (OAuth 2.1 with refresh tokens)
app.post("/oauth/token", async (c) => {
  // OAuth 2.1: Enforce HTTPS (except for loopback)
  const httpsError = enforceHTTPS(c);
  if (httpsError) return httpsError;

  const formData = await c.req.formData();
  const grantType = formData.get("grant_type")?.toString();

  // Authenticate client (supports both public and confidential clients)
  const tokenEndpointUrl = new URL(c.req.url).origin + "/oauth/token";
  const authResult = await authenticateClient(c.env.DB, formData, tokenEndpointUrl);

  if (!authResult.authenticated) {
    return c.json(
      {
        error: authResult.error || "invalid_client",
        error_description: authResult.errorDescription
      },
      400
    );
  }

  const clientId = authResult.clientId!;

  // Get full application record
  const app = await c.env.DB.prepare(
    "SELECT * FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return c.json({ error: "invalid_client" }, 400);
  }

  // Handle authorization_code grant
  if (grantType === "authorization_code") {
    const code = formData.get("code")?.toString();
    const redirectUri = formData.get("redirect_uri")?.toString();
    const codeVerifier = formData.get("code_verifier")?.toString();

    if (!code) {
      return c.json({ error: "invalid_request", error_description: "code is required" }, 400);
    }

    const authCode = await c.env.DB.prepare(
      "SELECT * FROM auth_codes WHERE code = ? AND client_id = ?"
    ).bind(code, clientId).first();

    if (!authCode || (authCode.expires_at as number) < Date.now()) {
      return c.json({ error: "invalid_grant" }, 400);
    }

    // OAuth 2.1: Verify redirect_uri matches the one from authorization request
    if (redirectUri !== authCode.redirect_uri) {
      return c.json({
        error: "invalid_grant",
        error_description: "redirect_uri does not match authorization request"
      }, 400);
    }

    // OAuth 2.1: PKCE verification is mandatory
    const codeChallenge = authCode.code_challenge as string | null;
    const codeChallengeMethod = authCode.code_challenge_method as string | null;

    if (!codeChallenge) {
      return c.json({
        error: "invalid_grant",
        error_description: "Authorization code was not issued with PKCE"
      }, 400);
    }

    if (!codeVerifier) {
      return c.json({
        error: "invalid_request",
        error_description: "code_verifier is required"
      }, 400);
    }

    if (!validateCodeVerifier(codeVerifier)) {
      return c.json({
        error: "invalid_request",
        error_description: "invalid code_verifier format"
      }, 400);
    }

    const isValid = await verifyPKCE(codeVerifier, codeChallenge, codeChallengeMethod || "S256");
    if (!isValid) {
      return c.json({
        error: "invalid_grant",
        error_description: "code_verifier does not match code_challenge"
      }, 400);
    }

    // OAuth 2.1: Check for authorization code reuse
    // If tokens were already issued for this auth code, revoke them and reject the request
    const authCodeCreatedAt = authCode.created_at as number || (authCode.expires_at as number) - 10 * 60 * 1000;
    const recentTokens = await c.env.DB.prepare(
      `SELECT token FROM access_tokens
       WHERE client_id = ? AND user_id = ?
       AND created_at >= ? AND created_at <= ?`
    ).bind(
      clientId,
      authCode.user_id,
      authCodeCreatedAt - 1000, // 1 second before code creation
      Date.now()
    ).all();

    if (recentTokens.results && recentTokens.results.length > 0) {
      // Authorization code reuse detected - revoke all tokens for this client
      await revokeAllUserTokens(c.env.DB, authCode.user_id as string, clientId);

      // Log security event
      console.error("SECURITY: Authorization code reuse detected", {
        clientId,
        userId: authCode.user_id,
        code: code.substring(0, 8) + "...",
        tokensRevoked: recentTokens.results.length
      });

      return c.json({
        error: "invalid_grant",
        error_description: "Authorization code has already been used"
      }, 400);
    }

    // Check if this is an OIDC request and get auth data BEFORE deleting the code
    const scope = authCode.scope as string || "profile";
    let idToken: string | undefined;
    let oidcData: any = null;

    if (isOIDCRequest(scope)) {
      // Get OIDC auth data before deleting auth_codes
      oidcData = await c.env.DB.prepare(
        "SELECT nonce, auth_time FROM oidc_auth_data WHERE code = ?"
      ).bind(code).first();
    }

    // Delete authorization code (one-time use)
    // This will also cascade delete oidc_auth_data due to foreign key constraint
    await c.env.DB.prepare("DELETE FROM auth_codes WHERE code = ?").bind(code).run();

    // Generate ID token if this is an OIDC request
    if (isOIDCRequest(scope)) {
      try {
        // Get user data
        const user = await c.env.DB.prepare(
          "SELECT * FROM users WHERE id = ?"
        ).bind(authCode.user_id).first();

        if (user && oidcData) {
          // Generate ID token
          const baseUrl = new URL(c.req.url).origin;
          idToken = await generateIDToken(
            c.env.DB,
            c.env.KV,
            user,
            clientId,
            oidcData.nonce as string | null,
            oidcData.auth_time as number,
            scope,
            baseUrl,
            c.env.KEY_ENCRYPTION_SECRET
          );
        }
      } catch (error) {
        // Continue without ID token - don't fail the entire token request
      }
    }

    // Issue access token and refresh token
    const tokens = await issueTokens(c.env.DB, authCode.user_id as string, clientId, scope, idToken);

    // OAuth 2.1: Token responses must include Cache-Control: no-store
    return c.json(tokens, 200, {
      "Cache-Control": "no-store",
      "Pragma": "no-cache"
    });
  }

  // Handle refresh_token grant
  if (grantType === "refresh_token") {
    const refreshToken = formData.get("refresh_token")?.toString();

    if (!refreshToken) {
      return c.json({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
    }

    const tokens = await refreshAccessToken(c.env.DB, refreshToken);

    if (!tokens) {
      return c.json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, 400);
    }

    // OAuth 2.1: Token responses must include Cache-Control: no-store
    return c.json(tokens, 200, {
      "Cache-Control": "no-store",
      "Pragma": "no-cache"
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

// User info endpoint (OAuth 2.1 / OIDC)
app.get("/oauth/userinfo", async (c) => {
  const authorization = c.req.header("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    // 完全没带凭据 —— 按 RFC 6750 §3 不发 error 码，只发裸的 Bearer
    c.header("WWW-Authenticate", bearerChallenge());
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authorization.substring(7);

  // Validate access token
  const tokenInfo = await validateAccessToken(c.env.DB, token);

  if (!tokenInfo) {
    c.header(
      "WWW-Authenticate",
      bearerChallenge("invalid_token", "The access token is invalid or expired")
    );
    return c.json({ error: "invalid_token" }, 401);
  }

  // Get user info
  const user = await c.env.DB.prepare(
    "SELECT id, username, email, display_name, avatar_url, bio FROM users WHERE id = ?"
  ).bind(tokenInfo.userId).first();

  if (!user) {
    /*
     * token 有效但用户行没了（比如账号已删除）。
     * 对客户端而言这把 token 就是不能用了 —— 与 invalid_token 同一类。
     */
    c.header(
      "WWW-Authenticate",
      bearerChallenge("invalid_token", "The access token is invalid or expired")
    );
    return c.json({ error: "invalid_token" }, 401);
  }

  // Build OIDC-compliant response
  const userInfo: any = {
    sub: user.id  // OIDC requires 'sub' claim
  };

  // Add claims based on scope
  if (hasScopes(tokenInfo.scope, [SCOPES.PROFILE])) {
    userInfo.preferred_username = user.username;
    userInfo.name = user.display_name;
    if (user.avatar_url) {
      userInfo.picture = user.avatar_url;
    }
    if (user.bio) {
      userInfo.bio = user.bio;
    }
  }

  if (hasScopes(tokenInfo.scope, [SCOPES.EMAIL])) {
    userInfo.email = user.email;
    // 与 ID Token 用同一个常量 —— 两处发不一样的值会让接入方无所适从，
    // 而且这种不一致没有任何东西会报错。理由见 EMAIL_VERIFIED 的注释。
    userInfo.email_verified = EMAIL_VERIFIED;
  }

  // OAuth 2.1: Responses with sensitive data must include Cache-Control: no-store
  return c.json(userInfo, 200, {
    "Cache-Control": "no-store",
    "Pragma": "no-cache"
  });
});

// Token revocation endpoint (RFC 7009)
app.post("/oauth/revoke", async (c) => {
  const formData = await c.req.formData();
  const token = formData.get("token")?.toString();
  const tokenTypeHint = formData.get("token_type_hint")?.toString();

  if (!token) {
    return c.json({ error: "invalid_request" }, 400);
  }

  /*
   * 撤销逻辑在 lib/revoke.ts —— 那里能用真 SQL 测。
   *
   * 返回值故意不影响状态码：RFC 7009 §2.2 要求 token 不存在或无效时
   * **也返回 200**。把「没删到」变成 4xx 会让客户端的登出流程报错，
   * 而那时候本来就该当作已登出。
   */
  await revokeToken(c.env.DB, token, tokenTypeHint);
  return c.json({ success: true }, 200);
});

// ============================================
// Static file serving
// ============================================

// Serve SPA for all non-API routes
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;

  // Serve static assets directly
  if (path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|webmanifest|md|MD)$/)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  // Serve LICENSE file
  if (path === "/LICENSE") {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  // Serve docs.html for /docs
  if (path === "/docs") {
    const url = new URL(c.req.url);
    url.pathname = "/docs.html";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  }

  // Serve index.html for all other routes (SPA)
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

/**
 * 定时任务：签名密钥轮换。
 *
 * ── 这里此前有个把整件事变成空转的 bug ──────────────────────────
 *
 * 原来的写法是 `if (event.cron === "0 0 * * 0")`，而 wrangler.toml 里配的是
 * `crons = ["0 0 * * SUN"]`。Cloudflare 传给 `event.cron` 的**就是配置里
 * 那一行原文**，两个字符串不相等 —— 于是 checkAndRotateKeys 一次都没跑过。
 *
 * 后果不是「少转了一次密钥」：cron 对不上（此前已修）只是触发器失灵，
 * 而 keys.ts 里签名侧不看 expires_at、JWKS 又会把过期钥匙剔除，两者叠加
 * 就成了「用一把没发布在 JWKS 里的钥匙签 token」。线上 jwks.json 实测返回
 * `{"keys":[]}`，任何按 OIDC 规范拿 JWKS 验签的客户端都验不过。
 *
 * ── 现在的分工 ──────────────────────────────────────────────────
 *
 * 这个定时任务是**主动轮换**：提前于过期换钥匙，让新钥匙在被需要前就已发布。
 * keys.ts 的签名路径（getCurrentSigningKey）只是兜底 —— 只有当调度整个停摆、
 * 现有钥匙都过期时，它才会即时补一把，绝不拿过期钥匙签名。
 *
 * cron 比较此前被删掉了：只有一条 cron，比较只提供一种失效方式；
 * checkAndRotateKeys 本身幂等。将来加第二条 cron 再按 event.cron 分派 ——
 * 那时 test/key-rotation.test.ts 会要求新字符串必须与配置对得上。
 */
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    await checkAndRotateKeys(env.DB, env.KV, env.KEY_ENCRYPTION_SECRET);
  }
};
