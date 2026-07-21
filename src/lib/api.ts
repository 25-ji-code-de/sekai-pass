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
import { initializeLucia } from "./auth";
import { hashPassword, verifyPassword, generateId } from "./password";
import { decryptPassword, validateRequest } from "./decrypt";
import { verifyTurnstile } from "./turnstile";
import { createChallengeState, generatePoWChallenge, verifyPoWHash, type ChallengeState } from "./pow";
import { validateScopeParameter, formatScopes } from "./scope";

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
};

type Variables = {
  user: any | null;
  session: any | null;
};

export const apiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function parseRedirectUris(redirectUris: string): string[] {
  try {
    const parsed = JSON.parse(redirectUris);
    if (Array.isArray(parsed)) return parsed;
    return [String(parsed)];
  } catch {
    return redirectUris.split(',').map(uri => uri.trim()).filter(uri => uri.length > 0);
  }
}

function isLoopback(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

// Public configuration endpoint
apiRouter.get("/config", async (c) => {
  return c.json({
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || ''
  });
});

// OAuth configuration endpoint
apiRouter.get("/oauth/config", async (c) => {
  const baseUrl = new URL(c.req.url).origin;

  return c.json({
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    pkce_supported: true,
    code_challenge_methods: ["S256"]
  });
});

// Challenge init — issue a session challenge
apiRouter.get("/challenge/init", async (c) => {
  const challengeId = crypto.randomUUID();
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
  const state = createChallengeState(ip);
  await c.env.KV.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 300 });
  return c.json({ challengeId });
});

// Challenge report — client reports Turnstile load status, server decides method
apiRouter.post("/challenge/report", async (c) => {
  const { challengeId, turnstileLoaded } = await c.req.json();
  const raw = await c.env.KV.get(`challenge:${challengeId}`);
  if (!raw) return c.json({ error: "无效的验证会话" }, 400);

  const state: ChallengeState = JSON.parse(raw);
  if (state.used) return c.json({ error: "验证会话已使用" }, 403);

  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";
  if (state.ip !== ip && state.ip !== "unknown") return c.json({ error: "验证会话 IP 不匹配" }, 403);

  if (turnstileLoaded) {
    state.turnstileAttempted = true;
    await c.env.KV.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 300 });
    return c.json({ method: 'turnstile' });
  } else {
    const pow = generatePoWChallenge();
    state.powIssued = true;
    state.powChallenge = pow.challenge;
    await c.env.KV.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 300 });
    return c.json({ method: 'pow', challenge: pow.challenge, difficulty: pow.difficulty });
  }
});

// Verify captcha: stateful, checks KV challenge state
async function verifyCaptcha(
  body: Record<string, any>,
  kv: KVNamespace,
  secretKey: string,
  remoteIp?: string
): Promise<string | null> {
  const challengeId = body.challengeId;
  if (!challengeId) return "请完成人机验证";

  const raw = await kv.get(`challenge:${challengeId}`);
  if (!raw) return "验证会话无效或已过期";

  const state: ChallengeState = JSON.parse(raw);
  if (state.used) return "验证会话已使用";
  if (Date.now() - state.issued > 5 * 60 * 1000) return "验证会话已过期";
  if (state.ip !== remoteIp && state.ip !== "unknown") return "验证会话 IP 不匹配";

  const type = body.captchaType;

  if (type === 'turnstile') {
    const token = body["cf-turnstile-response"];
    if (!token) return "请完成人机验证";
    const valid = await verifyTurnstile(token, secretKey, remoteIp);
    if (!valid) return "人机验证失败，请重试";
  } else if (type === 'pow') {
    if (!state.powIssued) return "未授权的验证方式";
    const nonce = body.powNonce;
    if (!nonce || !state.powChallenge) return "验证数据不完整";
    const valid = await verifyPoWHash(state.powChallenge, nonce);
    if (!valid) return "人机验证失败，请重试";
  } else {
    return "请完成人机验证";
  }

  // Mark as used (anti-replay)
  state.used = true;
  await kv.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 60 });

  return null;
}

// Middleware to validate session from Bearer token
apiRouter.use("*", async (c, next) => {
  const authorization = c.req.header("Authorization");

  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.substring(7);
    const lucia = initializeLucia(c.env.DB);

    try {
      const { session, user } = await lucia.validateSession(token);
      c.set("user", user);
      c.set("session", session);
    } catch (error) {
      c.set("user", null);
      c.set("session", null);
    }
  } else {
    c.set("user", null);
    c.set("session", null);
  }

  await next();
});

// Login endpoint
apiRouter.post("/auth/login", async (c) => {
  try {
    const body = await c.req.json();
    const { username, p: encryptedPassword, nonce, fp: fingerprint, ts: timestamp } = body;

    if (!username || !encryptedPassword) {
      return c.json({ error: "用户名和密码不能为空" }, 400);
    }

    // Verify captcha (Turnstile or PoW fallback)
    const remoteIp = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");
    const captchaError = await verifyCaptcha(body, c.env.KV, c.env.TURNSTILE_SECRET_KEY, remoteIp);
    if (captchaError) {
      return c.json({ error: captchaError }, 400);
    }

    // Validate request parameters
    if (!validateRequest(nonce || null, fingerprint || null, timestamp || null)) {
      return c.json({ error: "请求参数无效" }, 400);
    }

    // Decrypt password
    const password = decryptPassword(encryptedPassword);

    const result = await c.env.DB.prepare(
      "SELECT * FROM users WHERE username = ?"
    ).bind(username).first();

    if (!result) {
      return c.json({ error: "用户名或密码错误" }, 400);
    }

    const validPassword = await verifyPassword(password, result.hashed_password as string);

    if (!validPassword) {
      return c.json({ error: "用户名或密码错误" }, 400);
    }

    const lucia = initializeLucia(c.env.DB);
    const session = await lucia.createSession(result.id as string, {});

    // Set session cookie for OAuth flow
    const sessionCookie = lucia.createSessionCookie(session.id);
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

    return c.json({
      success: true,
      token: session.id,
      user: {
        id: result.id,
        username: result.username,
        email: result.email,
        display_name: result.display_name
      }
    }, 200, {
      "Cache-Control": "no-store",
      "Pragma": "no-cache"
    });
  } catch (error) {
    console.error("Login error:", error);
    return c.json({ error: "登录失败，请重试" }, 500);
  }
});

// Register endpoint
apiRouter.post("/auth/register", async (c) => {
  try {
    const body = await c.req.json();
    const { username, email, p: encryptedPassword, display_name, nonce, fp: fingerprint, ts: timestamp } = body;

    if (!username || !email || !encryptedPassword) {
      return c.json({ error: "所有必填项不能为空" }, 400);
    }

    // Verify captcha (Turnstile or PoW fallback)
    const remoteIp = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");
    const captchaError = await verifyCaptcha(body, c.env.KV, c.env.TURNSTILE_SECRET_KEY, remoteIp);
    if (captchaError) {
      return c.json({ error: captchaError }, 400);
    }

    // Validate request parameters
    if (!validateRequest(nonce || null, fingerprint || null, timestamp || null)) {
      return c.json({ error: "请求参数无效" }, 400);
    }

    // Decrypt password
    const password = decryptPassword(encryptedPassword);

    if (password.length < 8) {
      return c.json({ error: "密码长度至少为 8 个字符" }, 400);
    }

    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE username = ? OR email = ?"
    ).bind(username, email).first();

    if (existingUser) {
      return c.json({ error: "用户名或邮箱已被使用" }, 400);
    }

    const userId = generateId();
    const hashedPassword = await hashPassword(password);
    const now = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO users (id, username, email, hashed_password, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, username, email, hashedPassword, display_name || null, now, now).run();

    const lucia = initializeLucia(c.env.DB);
    const session = await lucia.createSession(userId, {});

    // Set session cookie for OAuth flow
    const sessionCookie = lucia.createSessionCookie(session.id);
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

    return c.json({
      success: true,
      token: session.id,
      user: {
        id: userId,
        username,
        email,
        display_name
      }
    }, 200, {
      "Cache-Control": "no-store",
      "Pragma": "no-cache"
    });
  } catch (error) {
    console.error("Registration error:", error);
    return c.json({ error: "注册失败，请重试" }, 500);
  }
});

// Get current user
apiRouter.get("/auth/me", async (c) => {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "未授权" }, 401);
  }

  // Session attributes may lag behind profile updates; read latest from DB
  const row = await c.env.DB.prepare(
    "SELECT id, username, email, display_name, avatar_url, bio FROM users WHERE id = ?"
  ).bind(user.id).first();

  if (!row) {
    return c.json({ error: "未授权" }, 401);
  }

  return c.json({
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    bio: row.bio
  }, 200, {
    "Cache-Control": "no-store",
    "Pragma": "no-cache"
  });
});

// Update user profile
apiRouter.put("/auth/profile", async (c) => {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "未授权" }, 401);
  }

  try {
    const body = await c.req.json();
    const { display_name, avatar_url, bio } = body;

    // Validate fields
    if (display_name !== undefined && display_name !== null) {
      if (typeof display_name !== 'string' || display_name.length > 50) {
        return c.json({ error: "昵称长度不能超过 50 个字符" }, 400);
      }
    }

    if (avatar_url !== undefined && avatar_url !== null && avatar_url !== '') {
      if (typeof avatar_url !== 'string' || avatar_url.length > 500) {
        return c.json({ error: "头像 URL 长度不能超过 500 个字符" }, 400);
      }
      // Basic URL validation — require HTTPS
      try {
        const urlObj = new URL(avatar_url);
        if (urlObj.protocol !== 'https:') {
          return c.json({ error: "头像 URL 必须使用 HTTPS 协议" }, 400);
        }
      } catch {
        return c.json({ error: "头像 URL 格式无效" }, 400);
      }
    }

    if (bio !== undefined && bio !== null) {
      if (typeof bio !== 'string' || bio.length > 200) {
        return c.json({ error: "个性签名长度不能超过 200 个字符" }, 400);
      }
    }

    const updates = [];
    const params = [];

    if (display_name !== undefined) {
      updates.push('display_name = ?');
      params.push(display_name === '' ? null : display_name);
    }
    if (avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      params.push(avatar_url === '' ? null : avatar_url);
    }
    if (bio !== undefined) {
      updates.push('bio = ?');
      params.push(bio === '' ? null : bio);
    }

    if (updates.length === 0) {
      return c.json({ error: "没有需要更新的字段" }, 400);
    }

    updates.push('updated_at = ?');
    params.push(Date.now());
    params.push(user.id);

    await c.env.DB.prepare(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...params).run();

    // Get updated user info
    const updatedUser = await c.env.DB.prepare(
      "SELECT id, username, email, display_name, avatar_url, bio FROM users WHERE id = ?"
    ).bind(user.id).first();

    return c.json({
      success: true,
      user: updatedUser ? {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        display_name: updatedUser.display_name,
        avatar_url: updatedUser.avatar_url,
        bio: updatedUser.bio
      } : null
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return c.json({ error: "更新资料失败，请重试" }, 500);
  }
});

// Logout endpoint
apiRouter.post("/auth/logout", async (c) => {
  const session = c.get("session");

  if (session) {
    const lucia = initializeLucia(c.env.DB);
    await lucia.invalidateSession(session.id);
  }

  return c.json({ success: true });
});

// Get OAuth application info
apiRouter.get("/oauth/app-info", async (c) => {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "未授权" }, 401);
  }

  const clientId = c.req.query("client_id");

  if (!clientId) {
    return c.json({ error: "缺少 client_id" }, 400);
  }

  const app = await c.env.DB.prepare(
    "SELECT id, name, client_id FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return c.json({ error: "应用不存在" }, 404);
  }

  return c.json({
    id: app.id,
    name: app.name,
    client_id: app.client_id
  });
});

// OAuth authorize endpoint (API version)
apiRouter.post("/oauth/authorize", async (c) => {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "未授权" }, 401);
  }

  try {
    const body = await c.req.json();
    const { client_id, redirect_uri, code_challenge, code_challenge_method, action, state } = body;

    if (action === "deny") {
      return c.json({ error: "access_denied" }, 403);
    }

    if (!client_id || !redirect_uri) {
      return c.json({ error: "缺少必要参数" }, 400);
    }

    // Validate redirect_uri against registered URIs
    const app = await c.env.DB.prepare(
      "SELECT * FROM applications WHERE client_id = ?"
    ).bind(client_id).first();

    if (!app) {
      return c.json({ error: "应用不存在" }, 404);
    }

    const allowedUris = parseRedirectUris(app.redirect_uris as string);
    if (!allowedUris.includes(redirect_uri)) {
      return c.json({ error: "Invalid redirect URI" }, 400);
    }

    // Enforce HTTPS on redirect_uri (except loopback)
    if (redirect_uri.startsWith('http:') && !isLoopback(redirect_uri)) {
      return c.json({ error: "redirect_uri must use HTTPS" }, 400);
    }

    // OAuth 2.1: PKCE is mandatory for all clients
    if (!code_challenge) {
      return c.json({ error: "code_challenge is required (PKCE mandatory)" }, 400);
    }

    // OAuth 2.1: Only S256 method is allowed
    const method = code_challenge_method || 'S256';
    if (method !== 'S256') {
      return c.json({ error: "Only S256 code_challenge_method is supported" }, 400);
    }

    // Validate and parse scope
    const scopeParam = body.scope || null;
    const scopeValidation = validateScopeParameter(scopeParam);
    if (!scopeValidation.valid) {
      return c.json({ error: scopeValidation.error || "Invalid scope" }, 400);
    }
    const scope = formatScopes(scopeValidation.scopes);

    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const createdAt = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, created_at, code_challenge, code_challenge_method, state, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, client_id, redirect_uri, expiresAt, createdAt, code_challenge, method, state || null, scope).run();

    // OAuth 2.1: Include issuer parameter to prevent mix-up attacks
    const issuer = new URL(c.req.url).origin;

    return c.json({
      success: true,
      code,
      iss: issuer,
      state: state || undefined
    });
  } catch (error) {
    console.error("OAuth authorize error:", error);
    return c.json({ error: "授权失败" }, 500);
  }
});
