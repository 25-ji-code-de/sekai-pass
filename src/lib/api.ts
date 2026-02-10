import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { initializeLucia } from "./auth";
import { hashPassword, verifyPassword, generateId } from "./password";
import { decryptPassword, validateRequest } from "./decrypt";
import { verifyTurnstile } from "./turnstile";

type Bindings = {
  DB: D1Database;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
};

type Variables = {
  user: any | null;
  session: any | null;
};

export const apiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
    const turnstileToken = body["cf-turnstile-response"];

    if (!username || !encryptedPassword) {
      return c.json({ error: "用户名和密码不能为空" }, 400);
    }

    // Verify Turnstile token
    if (!turnstileToken) {
      return c.json({ error: "请完成人机验证" }, 400);
    }

    const remoteIp = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");
    const turnstileValid = await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET_KEY, remoteIp);

    if (!turnstileValid) {
      return c.json({ error: "人机验证失败，请重试" }, 400);
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
    const turnstileToken = body["cf-turnstile-response"];

    if (!username || !email || !encryptedPassword) {
      return c.json({ error: "所有必填项不能为空" }, 400);
    }

    // Verify Turnstile token
    if (!turnstileToken) {
      return c.json({ error: "请完成人机验证" }, 400);
    }

    const remoteIp = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");
    const turnstileValid = await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET_KEY, remoteIp);

    if (!turnstileValid) {
      return c.json({ error: "人机验证失败，请重试" }, 400);
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

  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.displayName
  }, 200, {
    "Cache-Control": "no-store",
    "Pragma": "no-cache"
  });
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

    // OAuth 2.1: PKCE is mandatory for all clients
    if (!code_challenge) {
      return c.json({ error: "code_challenge is required (PKCE mandatory)" }, 400);
    }

    // OAuth 2.1: Only S256 method is allowed
    const method = code_challenge_method || 'S256';
    if (method !== 'S256') {
      return c.json({ error: "Only S256 code_challenge_method is supported" }, 400);
    }

    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const createdAt = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, created_at, code_challenge, code_challenge_method, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, client_id, redirect_uri, expiresAt, createdAt, code_challenge, method, state || null).run();

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
