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
import { initializeLucia } from "./auth.ts";
import { hashPassword, verifyPassword, generateId } from "./password.ts";
import { decryptPassword, validateRequest } from "./decrypt.ts";
import { getCaptchaProvider } from "./captcha-provider.ts";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type Base64URLString,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createChallengeState, generatePoWChallenge, verifyPoWHash, POW_DIFFICULTY, POW_DIFFICULTY_STRICT, type ChallengeState } from "./pow.ts";
import { validateScopeParameter, formatScopes } from "./scope.ts";
import { isOIDCRequest } from "./oidc-scope.ts";
import {
  listApplications,
  getApplication,
  createApplication,
  updateApplication,
  deleteApplication,
  isAtAppLimit,
  validateApplicationInput,
  MAX_APPS_PER_USER,
} from "./applications.ts";
import { isUniqueConstraintError } from "./db-errors.ts";
import {
  buildAuthorizationUrl,
  createPKCEChallenge,
  exchangeAuthorizationCode,
  getExternalProvider,
  isExternalProviderEnabled,
  isExternalProviderId,
  listEnabledExternalProviders,
  randomOAuthValue,
  resolveExternalIdentity,
  sanitizeExternalLoginRedirect,
  sanitizeInternalRedirect,
  type ExternalAuthEnv,
  type ExternalIdentity,
  type ExternalProviderId,
} from "./external-auth.ts";
import {
  listClientKeys,
  addClientKey,
  setClientKeyStatus,
  deleteClientKey,
  MAX_KEYS_PER_APP,
  KEY_STATUSES,
  type KeyStatus,
} from "./client-keys.ts";
import {
  bytesToBase64URL,
  encodeUserHandle,
  getPasskeyRP,
  isPasskeyChallengeFresh,
  MAX_PASSKEYS_PER_USER,
  normalizePasskeyName,
  parsePasskeyChallenge,
  parseTransports,
  PASSKEY_CHALLENGE_TTL,
  serializeTransports,
  toWebAuthnCredential,
  type PasskeyChallengeState,
  type StoredPasskeyRow,
} from "./passkeys.ts";

type Bindings = ExternalAuthEnv & {
  DB: D1Database;
  KV: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
  HCAPTCHA_SECRET_KEY?: string;
  HCAPTCHA_SITE_KEY?: string;
  /** Comma-separated ISO country codes that get PoW up-front (default "CN"). */
  POW_FAST_COUNTRIES?: string;
};

type Variables = {
  user: any | null;
  session: any | null;
};

export const apiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type ExternalFlowState = {
  provider: ExternalProviderId;
  verifier: string;
  nonce: string;
  redirect: string;
  mode: "login" | "link";
  userId?: string;
  createdAt: number;
};

type ExternalPendingState = {
  identity: ExternalIdentity;
  redirect: string;
  createdAt: number;
};

const EXTERNAL_FLOW_TTL = 10 * 60;

function externalCallbackUrl(requestUrl: string, provider: ExternalProviderId): string {
  return `${new URL(requestUrl).origin}/api/auth/external/${provider}/callback`;
}

function externalErrorRedirect(message: string, mode: "login" | "link" = "login"): string {
  const path = mode === "link" ? "/settings" : "/login";
  const params = new URLSearchParams({ external_error: message });
  return `${path}?${params}`;
}

async function createExternalSession(
  c: any,
  userId: string,
  redirect: string,
): Promise<string> {
  const lucia = initializeLucia(c.env.DB);
  const session = await lucia.createSession(userId, {});
  const sessionCookie = lucia.createSessionCookie(session.id);
  setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

  const ticket = randomOAuthValue();
  await c.env.KV.put(
    `external:handoff:${ticket}`,
    JSON.stringify({ sessionId: session.id, redirect }),
    { expirationTtl: EXTERNAL_FLOW_TTL },
  );
  return ticket;
}

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
      nonce: string | null;
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
    scope: formatScopes(scopeValidation.scopes),
    nonce: body.nonce || null
  };
}

// Public configuration endpoint
apiRouter.get("/config", async (c) => {
  return c.json({
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || '',
    hcaptcha_site_key: c.env.HCAPTCHA_SITE_KEY || '',
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
  const requestedProvider = new URL(c.req.url).searchParams.get("provider") || "turnstile";
  const provider = getCaptchaProvider(requestedProvider);
  if (!provider) return c.json({ error: "不支持的人机验证提供商" }, 400);

  const challengeId = crypto.randomUUID();
  const ip = clientIp(c);
  const state = createChallengeState(ip);
  state.captchaProvider = provider.name;

  let pow: { challenge: string; difficulty: number } | null = null;
  if (provider.name === "turnstile" && isPowFastRegion(c)) {
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

  if (state.captchaProvider === "hcaptcha") {
    return c.json({ error: "hCaptcha 不支持 PoW 降级" }, 400);
  }

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
  turnstileSecretKey: string,
  hcaptchaSecretKey: string | undefined,
  requiredProvider: "turnstile" | "hcaptcha",
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
  const expectedProvider = state.captchaProvider || "turnstile";
  if (expectedProvider !== requiredProvider) {
    return "验证方式与当前操作不匹配";
  }
  if (type !== expectedProvider && !(expectedProvider === "turnstile" && type === "pow")) {
    return "验证方式与验证会话不匹配";
  }

  if (type === 'turnstile') {
    const provider = getCaptchaProvider("turnstile")!;
    const token = body[provider.responseField];
    if (!token) return "请完成人机验证";
    const result = await provider.verify(token, turnstileSecretKey);
    if (!result.success) {
      console.error('Turnstile reject for challenge', challengeId, result.errorCodes, 'ip=', remoteIp);
      return "人机验证失败，请重试";
    }
  } else if (type === 'hcaptcha') {
    const provider = getCaptchaProvider("hcaptcha")!;
    const token = body[provider.responseField];
    if (!token) return "请完成人机验证";
    const result = await provider.verify(token, hcaptchaSecretKey || "", remoteIp);
    if (!result.success) {
      console.error('hCaptcha reject for challenge', challengeId, result.errorCodes, 'ip=', remoteIp);
      return "人机验证失败，请重试";
    }
  } else if (type === 'pow') {
    if (expectedProvider !== "turnstile" || !state.powIssued) return "未授权的验证方式";
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

// OAuth callback and handoff responses contain one-time credentials and must
// never be cached by an edge or browser.
apiRouter.use("/auth/external/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("CDN-Cache-Control", "no-store");
});

apiRouter.use("/auth/passkeys/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("CDN-Cache-Control", "no-store");
});

// Enabled upstream providers only. Client ids and secrets are never returned.
apiRouter.get("/auth/external/providers", async (c) => {
  return c.json({ providers: listEnabledExternalProviders(c.env) }, 200, {
    "Cache-Control": "public, max-age=300",
  });
});

// Create a stateful OAuth flow and return the upstream authorization URL.
apiRouter.post("/auth/external/:provider/start", async (c) => {
  const providerId = c.req.param("provider");
  if (!isExternalProviderId(providerId) || !isExternalProviderEnabled(c.env, providerId)) {
    return c.json({ error: "该登录方式暂不可用" }, 404);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const mode = body.mode === "link" ? "link" : "login";
  const user = c.get("user");
  if (mode === "link" && !user) return c.json({ error: "未授权" }, 401);

  const state = randomOAuthValue();
  const verifier = randomOAuthValue(48);
  const nonce = randomOAuthValue();
  const redirect = mode === "link" ? "/settings" : sanitizeExternalLoginRedirect(body.redirect);
  const flow: ExternalFlowState = {
    provider: providerId,
    verifier,
    nonce,
    redirect,
    mode,
    userId: mode === "link" ? user.id : undefined,
    createdAt: Date.now(),
  };
  await c.env.KV.put(`external:flow:${state}`, JSON.stringify(flow), {
    expirationTtl: EXTERNAL_FLOW_TTL,
  });

  const callbackUrl = externalCallbackUrl(c.req.url, providerId);
  const challenge = await createPKCEChallenge(verifier);
  return c.json({
    authorization_url: buildAuthorizationUrl(
      c.env,
      providerId,
      callbackUrl,
      state,
      challenge,
      nonce,
    ),
  });
});

apiRouter.get("/auth/external/:provider/callback", async (c) => {
  const providerId = c.req.param("provider");
  const state = c.req.query("state") || "";
  if (!isExternalProviderId(providerId) || !state) {
    return c.redirect(externalErrorRedirect("登录请求无效"));
  }

  const key = `external:flow:${state}`;
  const raw = await c.env.KV.get(key);
  if (!raw) return c.redirect(externalErrorRedirect("登录请求已失效，请重试"));
  await c.env.KV.delete(key);

  let flow: ExternalFlowState;
  try {
    flow = JSON.parse(raw) as ExternalFlowState;
  } catch {
    return c.redirect(externalErrorRedirect("登录请求无效"));
  }
  if (
    flow.provider !== providerId ||
    Date.now() - flow.createdAt > EXTERNAL_FLOW_TTL * 1000
  ) {
    return c.redirect(externalErrorRedirect("登录请求无效", flow.mode));
  }
  if (c.req.query("error")) {
    return c.redirect(externalErrorRedirect("第三方授权已取消", flow.mode));
  }
  const code = c.req.query("code");
  if (!code) return c.redirect(externalErrorRedirect("第三方未返回授权码", flow.mode));

  try {
    const callbackUrl = externalCallbackUrl(c.req.url, providerId);
    const token = await exchangeAuthorizationCode(
      c.env,
      providerId,
      code,
      flow.verifier,
      callbackUrl,
    );
    const identity = await resolveExternalIdentity(
      c.env,
      providerId,
      token.accessToken,
      token.idToken,
      flow.nonce,
    );

    const linked = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    ).bind(providerId, identity.subject).first();

    if (flow.mode === "link") {
      if (!flow.userId) return c.redirect(externalErrorRedirect("绑定请求无效", "link"));
      if (linked && linked.user_id !== flow.userId) {
        return c.redirect(externalErrorRedirect("该第三方账号已绑定其他 SEKAI Pass 账号", "link"));
      }
      if (!linked) {
        await c.env.DB.prepare(
          "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)",
        ).bind(providerId, identity.subject, flow.userId, Date.now()).run();
      }
      return c.redirect(`/settings?external=linked&provider=${encodeURIComponent(providerId)}`);
    }

    if (linked) {
      const ticket = await createExternalSession(c, String(linked.user_id), flow.redirect);
      return c.redirect(`/external/complete?ticket=${encodeURIComponent(ticket)}`);
    }

    const ticket = randomOAuthValue();
    const pending: ExternalPendingState = { identity, redirect: flow.redirect, createdAt: Date.now() };
    await c.env.KV.put(`external:pending:${ticket}`, JSON.stringify(pending), {
      expirationTtl: EXTERNAL_FLOW_TTL,
    });
    return c.redirect(`/external/complete?ticket=${encodeURIComponent(ticket)}`);
  } catch (error) {
    console.error(`External auth callback failed (${providerId}):`, error);
    return c.redirect(externalErrorRedirect("第三方登录失败，请重试", flow.mode));
  }
});

apiRouter.get("/auth/external/pending", async (c) => {
  const ticket = c.req.query("ticket") || "";
  if (!ticket) return c.json({ error: "登录票据无效" }, 400);
  const raw = await c.env.KV.get(`external:pending:${ticket}`);
  if (!raw) return c.json({ error: "登录票据已失效，请重新登录" }, 410);
  const pending = JSON.parse(raw) as ExternalPendingState;
  if (Date.now() - pending.createdAt > EXTERNAL_FLOW_TTL * 1000) {
    return c.json({ error: "登录票据已失效，请重新登录" }, 410);
  }
  const provider = getExternalProvider(pending.identity.provider);
  return c.json({
    needs_profile: true,
    provider: { id: provider.id, name: provider.name, icon: provider.icon },
    profile: {
      email: pending.identity.email,
      email_verified: pending.identity.emailVerified,
      display_name: pending.identity.displayName,
      avatar_url: pending.identity.avatarUrl,
    },
  }, 200, { "Cache-Control": "no-store" });
});

apiRouter.post("/auth/external/handoff", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  if (!ticket) return c.json({ error: "登录票据无效" }, 400);
  const key = `external:handoff:${ticket}`;
  const raw = await c.env.KV.get(key);
  if (!raw) return c.json({ error: "登录票据已失效，请重新登录" }, 410);
  const handoff = JSON.parse(raw) as { sessionId: string; redirect: string };
  const lucia = initializeLucia(c.env.DB);
  let session;
  let user;
  for (let attempt = 0; attempt < 3; attempt++) {
    ({ session, user } = await lucia.validateSession(handoff.sessionId));
    if (session && user) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  if (!session || !user) return c.json({ error: "登录会话无效" }, 401);
  const response = c.json({
    token: session.id,
    redirect: sanitizeInternalRedirect(handoff.redirect),
  }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
  await c.env.KV.delete(key);
  return response;
});

apiRouter.post("/auth/external/complete", async (c) => {
  try {
    const body = await c.req.json() as Record<string, any>;
    const ticket = typeof body.ticket === "string" ? body.ticket : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!ticket || !username || !email || body.agree_terms !== true) {
      return c.json({ error: "请填写完整资料并同意服务协议" }, 400);
    }
    if (username.length > 50 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "用户名或邮箱格式无效" }, 400);
    }

    const captchaError = await verifyCaptcha(
      body,
      c.env.KV,
      c.env.TURNSTILE_SECRET_KEY,
      c.env.HCAPTCHA_SECRET_KEY,
      "hcaptcha",
      clientIp(c),
    );
    if (captchaError) return c.json({ error: captchaError }, 400);

    const pendingKey = `external:pending:${ticket}`;
    const raw = await c.env.KV.get(pendingKey);
    if (!raw) return c.json({ error: "登录票据已失效，请重新登录" }, 410);
    const pending = JSON.parse(raw) as ExternalPendingState;
    if (Date.now() - pending.createdAt > EXTERNAL_FLOW_TTL * 1000) {
      return c.json({ error: "登录票据已失效，请重新登录" }, 410);
    }

    const existingAccount = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    ).bind(pending.identity.provider, pending.identity.subject).first();
    if (existingAccount) return c.json({ error: "该第三方账号已绑定，请重新登录" }, 409);

    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE username = ? OR email = ?",
    ).bind(username, email).first();
    if (existingUser) {
      return c.json({ error: "用户名或邮箱已被使用，请先登录已有账号后绑定" }, 409);
    }

    const userId = generateId();
    // PBKDF2 hashes are hex-only. This sentinel can never verify as a password
    // and lets existing databases distinguish social-only accounts without a migration.
    const unusablePassword = `!external:${randomOAuthValue(48)}`;
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users
          (id, username, email, hashed_password, display_name, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        username,
        email,
        unusablePassword,
        pending.identity.displayName,
        pending.identity.avatarUrl,
        now,
        now,
      ),
      c.env.DB.prepare(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(pending.identity.provider, pending.identity.subject, userId, now),
    ]);
    await c.env.KV.delete(pendingKey);

    const sessionTicket = await createExternalSession(c, userId, pending.redirect);
    return c.json({ handoff_ticket: sessionTicket }, 201, { "Cache-Control": "no-store" });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "用户名、邮箱或第三方账号已被使用" }, 409);
    }
    console.error("External account completion failed:", error);
    return c.json({ error: "创建账号失败，请重试" }, 500);
  }
});

apiRouter.get("/auth/external/accounts", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);
  const [accountResult, localUser] = await Promise.all([
    c.env.DB.prepare(
      "SELECT provider, created_at FROM oauth_accounts WHERE user_id = ? ORDER BY created_at",
    ).bind(user.id).all(),
    c.env.DB.prepare(
      "SELECT hashed_password FROM users WHERE id = ?",
    ).bind(user.id).first(),
  ]);
  const enabled = new Set(listEnabledExternalProviders(c.env).map((item) => item.id));
  const accounts = accountResult.results.map((row) => {
    const id = String(row.provider);
    if (!isExternalProviderId(id)) return null;
    const provider = getExternalProvider(id);
    return {
      id,
      name: provider.name,
      icon: provider.icon,
      available: enabled.has(id),
      created_at: row.created_at,
    };
  }).filter(Boolean);
  return c.json({
    password_login_enabled: !String(localUser?.hashed_password || "").startsWith("!external:"),
    accounts,
    providers: listEnabledExternalProviders(c.env),
  }, 200, { "Cache-Control": "no-store" });
});

apiRouter.delete("/auth/external/accounts/:provider", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);
  const providerId = c.req.param("provider");
  if (!isExternalProviderId(providerId)) return c.json({ error: "登录方式无效" }, 400);

  const [localUser, accounts, passkeyCount] = await Promise.all([
    c.env.DB.prepare("SELECT hashed_password FROM users WHERE id = ?").bind(user.id).first(),
    c.env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?").bind(user.id).all(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?")
      .bind(user.id).first<{ count: number }>(),
  ]);
  const hasPassword = !String(localUser?.hashed_password || "").startsWith("!external:");
  if (!hasPassword && accounts.results.length <= 1 && Number(passkeyCount?.count || 0) === 0) {
    return c.json({ error: "必须保留至少一种登录方式" }, 409);
  }
  await c.env.DB.prepare(
    "DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?",
  ).bind(user.id, providerId).run();
  return c.json({ success: true });
});

apiRouter.post("/auth/passkeys/register/options", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);

  const [localUser, existing] = await Promise.all([
    c.env.DB.prepare(
      "SELECT username, display_name FROM users WHERE id = ?",
    ).bind(user.id).first(),
    c.env.DB.prepare(
      "SELECT credential_id, transports FROM passkeys WHERE user_id = ? ORDER BY created_at",
    ).bind(user.id).all(),
  ]);
  if (!localUser) return c.json({ error: "账号不存在" }, 404);
  if (existing.results.length >= MAX_PASSKEYS_PER_USER) {
    return c.json({ error: `最多添加 ${MAX_PASSKEYS_PER_USER} 个通行密钥` }, 409);
  }

  const rp = getPasskeyRP(c.req.url);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: Uint8Array.from(new TextEncoder().encode(user.id)),
    userName: String(localUser.username),
    userDisplayName: String(localUser.display_name || localUser.username),
    attestationType: "none",
    excludeCredentials: existing.results.map((row) => ({
      id: String(row.credential_id) as Base64URLString,
      transports: parseTransports(row.transports),
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    preferredAuthenticatorType: "localDevice",
  });
  const flowId = randomOAuthValue();
  const flow: PasskeyChallengeState = {
    challenge: options.challenge,
    userId: user.id,
    rpID: rp.rpID,
    origin: rp.origin,
    createdAt: Date.now(),
  };
  await c.env.KV.put(`passkey:registration:${flowId}`, JSON.stringify(flow), {
    expirationTtl: PASSKEY_CHALLENGE_TTL,
  });
  return c.json({ flow_id: flowId, options });
});

apiRouter.post("/auth/passkeys/register/verify", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const flowId = typeof body.flow_id === "string" ? body.flow_id : "";
  const name = normalizePasskeyName(body.name);
  const response = body.response;
  if (!flowId || !name || !response || typeof response !== "object") {
    return c.json({ error: "通行密钥数据无效" }, 400);
  }

  const key = `passkey:registration:${flowId}`;
  const state = parsePasskeyChallenge(await c.env.KV.get(key), true);
  await c.env.KV.delete(key);
  const currentRP = getPasskeyRP(c.req.url);
  if (
    !state ||
    !isPasskeyChallengeFresh(state) ||
    state.userId !== user.id ||
    state.rpID !== currentRP.rpID ||
    state.origin !== currentRP.origin
  ) {
    return c.json({ error: "注册请求已失效，请重试" }, 410);
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: state.challenge,
      expectedOrigin: state.origin,
      expectedRPID: state.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "无法验证通行密钥" }, 400);
    }

    const info = verification.registrationInfo;
    const now = Date.now();
    const currentCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?",
    ).bind(user.id).first<{ count: number }>();
    if (Number(currentCount?.count || 0) >= MAX_PASSKEYS_PER_USER) {
      return c.json({ error: `最多添加 ${MAX_PASSKEYS_PER_USER} 个通行密钥` }, 409);
    }
    await c.env.DB.prepare(
      `INSERT INTO passkeys
        (credential_id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      info.credential.id,
      user.id,
      bytesToBase64URL(info.credential.publicKey),
      info.credential.counter,
      serializeTransports(info.credential.transports),
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      name,
      now,
    ).run();
    return c.json({
      passkey: {
        credential_id: info.credential.id,
        name,
        created_at: now,
        last_used_at: null,
        backed_up: info.credentialBackedUp,
      },
    }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "该通行密钥已经添加" }, 409);
    }
    console.error("Passkey registration failed:", error);
    return c.json({ error: "无法验证通行密钥，请重试" }, 400);
  }
});

apiRouter.post("/auth/passkeys/login/options", async (c) => {
  const rp = getPasskeyRP(c.req.url);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
  });
  const flowId = randomOAuthValue();
  const flow: PasskeyChallengeState = {
    challenge: options.challenge,
    rpID: rp.rpID,
    origin: rp.origin,
    createdAt: Date.now(),
  };
  await c.env.KV.put(`passkey:authentication:${flowId}`, JSON.stringify(flow), {
    expirationTtl: PASSKEY_CHALLENGE_TTL,
  });
  return c.json({ flow_id: flowId, options });
});

apiRouter.post("/auth/passkeys/login/verify", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const flowId = typeof body.flow_id === "string" ? body.flow_id : "";
  const response = body.response;
  if (!flowId || !response || typeof response !== "object") {
    return c.json({ error: "通行密钥数据无效" }, 400);
  }

  const key = `passkey:authentication:${flowId}`;
  const state = parsePasskeyChallenge(await c.env.KV.get(key), false);
  await c.env.KV.delete(key);
  const currentRP = getPasskeyRP(c.req.url);
  if (
    !state ||
    !isPasskeyChallengeFresh(state) ||
    state.rpID !== currentRP.rpID ||
    state.origin !== currentRP.origin
  ) {
    return c.json({ error: "登录请求已失效，请重试" }, 410);
  }

  const authenticationResponse = response as AuthenticationResponseJSON;
  const credentialId = typeof authenticationResponse.id === "string"
    ? authenticationResponse.id
    : "";
  if (!credentialId) return c.json({ error: "无法验证通行密钥" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT passkeys.*, users.username, users.email, users.display_name
     FROM passkeys INNER JOIN users ON users.id = passkeys.user_id
     WHERE passkeys.credential_id = ?`,
  ).bind(credentialId).first();
  if (!row) return c.json({ error: "无法验证通行密钥" }, 400);

  const userHandle = authenticationResponse.response?.userHandle;
  if (!userHandle || userHandle !== encodeUserHandle(String(row.user_id))) {
    return c.json({ error: "无法验证通行密钥" }, 400);
  }

  try {
    const stored = row as StoredPasskeyRow & Record<string, unknown>;
    const verification = await verifyAuthenticationResponse({
      response: authenticationResponse,
      expectedChallenge: state.challenge,
      expectedOrigin: state.origin,
      expectedRPID: state.rpID,
      credential: toWebAuthnCredential(stored),
      requireUserVerification: true,
    });
    if (!verification.verified) return c.json({ error: "无法验证通行密钥" }, 400);

    const now = Date.now();
    await c.env.DB.prepare(
      "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?",
    ).bind(
      verification.authenticationInfo.newCounter,
      now,
      credentialId,
    ).run();

    const lucia = initializeLucia(c.env.DB);
    const session = await lucia.createSession(String(row.user_id), {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
    return c.json({
      success: true,
      token: session.id,
      user: {
        id: row.user_id,
        username: row.username,
        email: row.email,
        display_name: row.display_name,
      },
    }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
  } catch (error) {
    console.error("Passkey authentication failed:", error);
    return c.json({ error: "无法验证通行密钥，请重试" }, 400);
  }
});

apiRouter.get("/auth/passkeys", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);
  const result = await c.env.DB.prepare(
    `SELECT credential_id, name, device_type, backed_up, created_at, last_used_at
     FROM passkeys WHERE user_id = ? ORDER BY created_at`,
  ).bind(user.id).all();
  return c.json({
    passkeys: result.results.map((row) => ({
      credential_id: row.credential_id,
      name: row.name,
      device_type: row.device_type,
      backed_up: Boolean(row.backed_up),
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    })),
    max_passkeys: MAX_PASSKEYS_PER_USER,
  });
});

apiRouter.patch("/auth/passkeys/:credentialId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const name = normalizePasskeyName(body.name);
  if (!name) return c.json({ error: "通行密钥名称须为 1 至 50 个字符" }, 400);
  const result = await c.env.DB.prepare(
    "UPDATE passkeys SET name = ? WHERE credential_id = ? AND user_id = ?",
  ).bind(name, c.req.param("credentialId"), user.id).run();
  if (!result.meta.changes) return c.json({ error: "通行密钥不存在" }, 404);
  return c.json({ success: true, name });
});

apiRouter.delete("/auth/passkeys/:credentialId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "未授权" }, 401);
  const credentialId = c.req.param("credentialId");
  const [passkey, localUser, oauthCount, passkeyCount] = await Promise.all([
    c.env.DB.prepare(
      "SELECT credential_id FROM passkeys WHERE credential_id = ? AND user_id = ?",
    ).bind(credentialId, user.id).first(),
    c.env.DB.prepare("SELECT hashed_password FROM users WHERE id = ?").bind(user.id).first(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM oauth_accounts WHERE user_id = ?")
      .bind(user.id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?")
      .bind(user.id).first<{ count: number }>(),
  ]);
  if (!passkey) return c.json({ error: "通行密钥不存在" }, 404);
  const hasPassword = !String(localUser?.hashed_password || "").startsWith("!external:");
  if (
    !hasPassword &&
    Number(oauthCount?.count || 0) === 0 &&
    Number(passkeyCount?.count || 0) <= 1
  ) {
    return c.json({ error: "必须保留至少一种登录方式" }, 409);
  }
  await c.env.DB.prepare(
    "DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?",
  ).bind(credentialId, user.id).run();
  return c.json({ success: true });
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
    const captchaError = await verifyCaptcha(body, c.env.KV, c.env.TURNSTILE_SECRET_KEY, c.env.HCAPTCHA_SECRET_KEY, "turnstile", clientIp(c));
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

    if (String(result.hashed_password).startsWith("!external:")) {
      return c.json({ error: "该账号未启用密码登录，请使用已绑定的第三方账号" }, 400);
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

    // Registration requires hCaptcha; Turnstile and PoW proofs are rejected.
    const captchaError = await verifyCaptcha(body, c.env.KV, c.env.TURNSTILE_SECRET_KEY, c.env.HCAPTCHA_SECRET_KEY, "hcaptcha", clientIp(c));
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
    /*
     * 并发注册：两个请求都通过了上面那个 SELECT，UNIQUE 约束拦下了第二个。
     *
     * 约束才是真正的守卫（它保证了不会有重复账号）；上面的 SELECT 只是为了
     * 给出好的错误消息。所以约束触发时也得给出**同样的**消息 ——
     * 否则用户看到的是一个像服务端故障的 500，而实际原因是「用户名被占了」，
     * 重试多少次都一样。
     */
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "用户名或邮箱已被使用" }, 400);
    }
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

    const { client_id, redirect_uri, code_challenge, method, state, scope, nonce } = validated;
    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const createdAt = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, created_at, code_challenge, code_challenge_method, state, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, client_id, redirect_uri, expiresAt, createdAt, code_challenge, method, state, scope).run();

    if (isOIDCRequest(scope)) {
      await c.env.DB.prepare(
        "INSERT INTO oidc_auth_data (code, nonce, auth_time) VALUES (?, ?, ?)"
      ).bind(code, nonce, createdAt).run();

      try {
        await c.env.DB.prepare(
          "UPDATE users SET last_auth_time = ? WHERE id = ?"
        ).bind(createdAt, user.id).run();
      } catch {
        // Backward-compatible with databases created before last_auth_time.
      }
    }

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

/* ═══════════════════════════════════════════════════════════════════
 *  开放平台 —— OAuth 应用自助管理
 *
 *  在这之前 applications 表没有任何写入代码，注册应用只能手工改库。
 *
 *  全部接口都要求已登录会话，并按 owner_user_id 隔离 ——
 *  拿到别人的 client_id 也读不到、改不了、删不掉。
 * ═══════════════════════════════════════════════════════════════════ */

/** 统一的未登录响应。 */
function requireUser(c: any) {
  const user = c.get("user");
  return user ?? null;
}

/** 把校验错误整理成统一形状。 */
function validationResponse(c: any, errors: { field: string; message: string }[]) {
  return c.json({ error: "invalid_request", details: errors }, 400);
}

// 列出我的应用
apiRouter.get("/apps", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  try {
    const apps = await listApplications(c.env.DB, user.id);
    return c.json({ applications: apps, limit: MAX_APPS_PER_USER }, 200, {
      "Cache-Control": "no-store",
    });
  } catch (error) {
    console.error("List applications error:", error);
    return c.json({ error: "获取应用列表失败" }, 500);
  }
});

// 创建应用
apiRouter.post("/apps", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", details: [{ field: "body", message: "不是合法 JSON" }] }, 400);
  }

  const errors = validateApplicationInput(body);
  if (errors.length) return validationResponse(c, errors);

  try {
    if (await isAtAppLimit(c.env.DB, user.id)) {
      return c.json(
        { error: "limit_reached", message: `每个账号最多创建 ${MAX_APPS_PER_USER} 个应用` },
        409,
      );
    }

    const { application } = await createApplication(c.env.DB, user.id, body);

    /*
     * 不返回 client_secret —— 本服务不用它认证任何东西。
     * token_endpoint_auth_methods_supported 只有 none 与 private_key_jwt。
     * 选了 private_key_jwt 的应用，下一步是去 /apps/:clientId/keys 登记公钥。
     */
    return c.json({ application }, 201, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Create application error:", error);
    return c.json({ error: "创建应用失败" }, 500);
  }
});

// 取单个应用
apiRouter.get("/apps/:clientId", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  try {
    const app = await getApplication(c.env.DB, c.req.param("clientId"), user.id);
    if (!app) return c.json({ error: "not_found" }, 404);
    return c.json({ application: app }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Get application error:", error);
    return c.json({ error: "获取应用失败" }, 500);
  }
});

// 更新应用
apiRouter.put("/apps/:clientId", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", details: [{ field: "body", message: "不是合法 JSON" }] }, 400);
  }

  const errors = validateApplicationInput(body, { partial: true });
  if (errors.length) return validationResponse(c, errors);

  try {
    const app = await updateApplication(c.env.DB, c.req.param("clientId"), user.id, body);
    if (!app) return c.json({ error: "not_found" }, 404);
    return c.json({ application: app }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Update application error:", error);
    return c.json({ error: "更新应用失败" }, 500);
  }
});

// 删除应用（连带清理它签发过的 token）
apiRouter.delete("/apps/:clientId", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  try {
    const deleted = await deleteApplication(c.env.DB, c.req.param("clientId"), user.id);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ success: true }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Delete application error:", error);
    return c.json({ error: "删除应用失败" }, 500);
  }
});

/*
 * 这里原本有 POST /apps/:clientId/rotate-secret。删掉了。
 *
 * 轮换一个不认证任何东西的值，只会让人以为自己刚做了一次安全操作。
 * private_key_jwt 的密钥轮换是真的有意义的，见下面的 /keys 接口：
 * 登记新公钥 → 客户端换用新私钥 → 撤销旧公钥，三步零停机。
 */

/* ═══════════════════════════════════════════════════════════════════
 *  private_key_jwt 公钥管理
 *
 *  开放平台第一版把应用管起来了，但 client_keys 还是只能手工插库 ——
 *  也就是说 token_endpoint_auth_method 选了 private_key_jwt 的应用，
 *  在注册公钥之前根本没法取 token。
 *
 *  与 /apps 一样按 owner 隔离：应用不属于你，这些接口一律 404。
 * ═══════════════════════════════════════════════════════════════════ */

// 列出某个应用的公钥
apiRouter.get("/apps/:clientId/keys", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  try {
    const keys = await listClientKeys(c.env.DB, c.req.param("clientId"), user.id);
    if (keys === null) return c.json({ error: "not_found" }, 404);
    return c.json({ keys, limit: MAX_KEYS_PER_APP }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("List client keys error:", error);
    return c.json({ error: "获取公钥列表失败" }, 500);
  }
});

// 注册公钥
apiRouter.post("/apps/:clientId/keys", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", details: [{ field: "body", message: "不是合法 JSON" }] }, 400);
  }

  try {
    const result = await addClientKey(c.env.DB, c.req.param("clientId"), user.id, body);
    if (!result.ok) {
      if ("notFound" in result) return c.json({ error: "not_found" }, 404);
      return validationResponse(c, result.errors);
    }
    return c.json({ key: result.key }, 201, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Add client key error:", error);
    return c.json({ error: "注册公钥失败" }, 500);
  }
});

// 改公钥状态（撤销 / 恢复）
apiRouter.patch("/apps/:clientId/keys/:keyId", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", details: [{ field: "body", message: "不是合法 JSON" }] }, 400);
  }

  if (!KEY_STATUSES.includes(body?.status)) {
    return validationResponse(c, [
      { field: "status", message: `只能是 ${KEY_STATUSES.join(" / ")}` },
    ]);
  }

  try {
    const key = await setClientKeyStatus(
      c.env.DB,
      c.req.param("clientId"),
      user.id,
      c.req.param("keyId"),
      body.status as KeyStatus,
    );
    if (!key) return c.json({ error: "not_found" }, 404);
    return c.json({ key }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Update client key error:", error);
    return c.json({ error: "更新公钥失败" }, 500);
  }
});

// 删除公钥
apiRouter.delete("/apps/:clientId/keys/:keyId", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "未授权" }, 401);

  try {
    const deleted = await deleteClientKey(
      c.env.DB,
      c.req.param("clientId"),
      user.id,
      c.req.param("keyId"),
    );
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ success: true }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Delete client key error:", error);
    return c.json({ error: "删除公钥失败" }, 500);
  }
});
