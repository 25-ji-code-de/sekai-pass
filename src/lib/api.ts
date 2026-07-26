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
import { verifyTurnstileDetailed } from "./turnstile";
import { createChallengeState, generatePoWChallenge, verifyPoWHash, POW_DIFFICULTY, POW_DIFFICULTY_STRICT, type ChallengeState } from "./pow";
import { validateScopeParameter, formatScopes } from "./scope";

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
  /** Comma-separated ISO country codes that get PoW up-front (default "CN"). */
  POW_FAST_COUNTRIES?: string;
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

type ProfileFieldError = { error: string };

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function validateDisplayName(value: unknown): ProfileFieldError | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 50) {
    return { error: "昵称长度不能超过 50 个字符" };
  }
  return null;
}

function validateAvatarUrl(value: unknown): ProfileFieldError | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 500) {
    return { error: "头像 URL 长度不能超过 500 个字符" };
  }
  try {
    const urlObj = new URL(value);
    if (urlObj.protocol !== 'https:') {
      return { error: "头像 URL 必须使用 HTTPS 协议" };
    }
  } catch {
    return { error: "头像 URL 格式无效" };
  }
  return null;
}

function validateBio(value: unknown): ProfileFieldError | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 200) {
    return { error: "个性签名长度不能超过 200 个字符" };
  }
  return null;
}

function buildProfileUpdate(
  body: { display_name?: unknown; avatar_url?: unknown; bio?: unknown }
): { error: string } | { updates: string[]; params: unknown[] } {
  const fieldError =
    validateDisplayName(body.display_name) ||
    validateAvatarUrl(body.avatar_url) ||
    validateBio(body.bio);
  if (fieldError) return fieldError;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.display_name !== undefined) {
    updates.push('display_name = ?');
    params.push(emptyToNull(body.display_name as string));
  }
  if (body.avatar_url !== undefined) {
    updates.push('avatar_url = ?');
    params.push(emptyToNull(body.avatar_url as string));
  }
  if (body.bio !== undefined) {
    updates.push('bio = ?');
    params.push(emptyToNull(body.bio as string));
  }

  if (updates.length === 0) {
    return { error: "没有需要更新的字段" };
  }

  return { updates, params };
}

function mapUserRow(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    bio: row.bio
  };
}

type AuthorizeValidation =
  | { error: string; status: 400 | 403 | 404 }
  | {
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      method: string;
      state: string | null;
      scope: string;
    };

function validateAuthorizeRequest(
  body: Record<string, any>,
  app: { redirect_uris: string } | null
): AuthorizeValidation {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, action, state } = body;

  if (action === "deny") {
    return { error: "access_denied", status: 403 };
  }

  if (!client_id || !redirect_uri) {
    return { error: "缺少必要参数", status: 400 };
  }

  if (!app) {
    return { error: "应用不存在", status: 404 };
  }

  const allowedUris = parseRedirectUris(app.redirect_uris);
  if (!allowedUris.includes(redirect_uri)) {
    return { error: "Invalid redirect URI", status: 400 };
  }

  if (redirect_uri.startsWith('http:') && !isLoopback(redirect_uri)) {
    return { error: "redirect_uri must use HTTPS", status: 400 };
  }

  if (!code_challenge) {
    return { error: "code_challenge is required (PKCE mandatory)", status: 400 };
  }

  const method = code_challenge_method || 'S256';
  if (method !== 'S256') {
    return { error: "Only S256 code_challenge_method is supported", status: 400 };
  }

  const scopeValidation = validateScopeParameter(body.scope || null);
  if (!scopeValidation.valid) {
    return { error: scopeValidation.error || "Invalid scope", status: 400 };
  }

  return {
    client_id,
    redirect_uri,
    code_challenge,
    method,
    state: state || null,
    scope: formatScopes(scopeValidation.scopes)
  };
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

/** Prefer CF-Connecting-IP; if only XFF exists, take the first hop (client). */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const cf = c.req.header("CF-Connecting-IP");
  if (cf) return cf.trim();
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return "unknown";
}

/**
 * Regions where challenges.cloudflare.com is unreliable enough that PoW is
 * issued up-front at baseline difficulty (mainland China primarily).
 * Everywhere else PoW stays a rate-limited, more expensive distress fallback,
 * so the effective bot barrier for the rest of the world remains Turnstile.
 */
function isPowFastRegion(c: { req: { raw: Request }; env: Bindings }): boolean {
  const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
  const country = String(cf?.country || "").toUpperCase();
  if (!country) return true; // local dev has no cf object
  return (c.env.POW_FAST_COUNTRIES || "CN")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .includes(country);
}

// Challenge init — issue a session challenge (with PoW attached in fast regions,
// so racing clients can start solving without an extra round trip)
apiRouter.get("/challenge/init", async (c) => {
  const challengeId = crypto.randomUUID();
  const ip = clientIp(c);
  const state = createChallengeState(ip);

  let pow: { challenge: string; difficulty: number } | null = null;
  if (isPowFastRegion(c)) {
    pow = generatePoWChallenge();
    state.powIssued = true;
    state.powChallenge = pow.challenge;
    state.powDifficulty = pow.difficulty;
  }

  await c.env.KV.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 300 });
  return c.json({ challengeId, pow });
});

// Challenge report — client reports Turnstile load status, server decides method
apiRouter.post("/challenge/report", async (c) => {
  const { challengeId, turnstileLoaded } = await c.req.json();
  const raw = await c.env.KV.get(`challenge:${challengeId}`);
  if (!raw) return c.json({ error: "无效的验证会话" }, 400);

  const state: ChallengeState = JSON.parse(raw);
  if (state.used) return c.json({ error: "验证会话已使用" }, 403);

  const ip = clientIp(c);
  if (state.ip !== ip && state.ip !== "unknown") return c.json({ error: "验证会话 IP 不匹配" }, 403);

  if (turnstileLoaded) {
    state.turnstileAttempted = true;
    await c.env.KV.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 300 });
    return c.json({ method: 'turnstile' });
  }

  // Idempotent: fast regions already got their PoW at init — hand back the same one.
  if (state.powIssued && state.powChallenge) {
    return c.json({
      method: 'pow',
      challenge: state.powChallenge,
      difficulty: state.powDifficulty ?? POW_DIFFICULTY,
    });
  }

  const fast = isPowFastRegion(c);
  if (!fast) {
    // Distress fallback outside fast regions: cap grants per IP so PoW stays a
    // lifeline for broken networks rather than the cheap path for bots.
    const rlKey = `powgrant:${ip}`;
    const granted = parseInt((await c.env.KV.get(rlKey)) || "0", 10);
    if (granted >= 30) return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
    await c.env.KV.put(rlKey, String(granted + 1), { expirationTtl: 3600 });
  }

  const pow = generatePoWChallenge(fast ? POW_DIFFICULTY : POW_DIFFICULTY_STRICT);
  state.powIssued = true;
  state.powChallenge = pow.challenge;
  state.powDifficulty = pow.difficulty;
  await c.env.KV.put(`challenge:${challengeId}`, JSON.stringify(state), { expirationTtl: 300 });
  return c.json({ method: 'pow', challenge: pow.challenge, difficulty: pow.difficulty });
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
    // remoteIp is intentionally not forwarded to siteverify (see turnstile.ts)
    const result = await verifyTurnstileDetailed(token, secretKey);
    if (!result.success) {
      console.error('Turnstile reject for challenge', challengeId, result.errorCodes, 'ip=', remoteIp);
      return "人机验证失败，请重试";
    }
  } else if (type === 'pow') {
    if (!state.powIssued) return "未授权的验证方式";
    const nonce = body.powNonce;
    if (!nonce || !state.powChallenge) return "验证数据不完整";
    const valid = await verifyPoWHash(state.powChallenge, nonce, state.powDifficulty ?? POW_DIFFICULTY);
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
    const captchaError = await verifyCaptcha(body, c.env.KV, c.env.TURNSTILE_SECRET_KEY, clientIp(c));
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
    const captchaError = await verifyCaptcha(body, c.env.KV, c.env.TURNSTILE_SECRET_KEY, clientIp(c));
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
    const built = buildProfileUpdate(body);
    if ('error' in built) {
      return c.json({ error: built.error }, 400);
    }

    const { updates, params } = built;
    updates.push('updated_at = ?');
    params.push(Date.now(), user.id);

    await c.env.DB.prepare(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = ?
    `).bind(...params).run();

    const updatedUser = await c.env.DB.prepare(
      "SELECT id, username, email, display_name, avatar_url, bio FROM users WHERE id = ?"
    ).bind(user.id).first();

    return c.json({
      success: true,
      user: mapUserRow(updatedUser as Record<string, unknown> | null)
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
    const app = body.client_id
      ? await c.env.DB.prepare(
          "SELECT * FROM applications WHERE client_id = ?"
        ).bind(body.client_id).first()
      : null;

    const validated = validateAuthorizeRequest(
      body,
      app ? { redirect_uris: app.redirect_uris as string } : null
    );

    if ('error' in validated) {
      return c.json({ error: validated.error }, validated.status);
    }

    const { client_id, redirect_uri, code_challenge, method, state, scope } = validated;
    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const createdAt = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, created_at, code_challenge, code_challenge_method, state, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, client_id, redirect_uri, expiresAt, createdAt, code_challenge, method, state, scope).run();

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
