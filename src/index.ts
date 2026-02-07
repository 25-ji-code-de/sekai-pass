import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { initializeLucia } from "./lib/auth";
import { hashPassword, verifyPassword, generateId } from "./lib/password";
import { decryptPassword, validateRequest } from "./lib/decrypt";
import { verifyPKCE, validateCodeChallenge, validateCodeVerifier } from "./lib/pkce";
import { verifyTurnstile } from "./lib/turnstile";
import * as html from "./lib/html";

type Bindings = {
  DB: D1Database;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
};

type Variables = {
  user: any | null;
  session: any | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// CORS middleware for OAuth endpoints
app.use("/oauth/*", cors({
  origin: "*", // 允许所有来源，生产环境可以限制为特定域名
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
  credentials: false,
}));

// Middleware to get current user
app.use("*", async (c, next) => {
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

// Home page
app.get("/", async (c) => {
  const user = c.get("user");

  if (user) {
    return c.html(html.dashboardPage(user));
  }

  return c.redirect("/login");
});

// Login page
app.get("/login", async (c) => {
  const user = c.get("user");
  if (user) {
    return c.redirect("/");
  }

  return c.html(html.loginForm(undefined, c.env.TURNSTILE_SITE_KEY));
});

// Login handler
app.post("/login", async (c) => {
  const lucia = initializeLucia(c.env.DB);
  const formData = await c.req.formData();
  const username = formData.get("username")?.toString();
  const encryptedPassword = formData.get("p")?.toString();
  const nonce = formData.get("nonce")?.toString();
  const fingerprint = formData.get("fp")?.toString();
  const timestamp = formData.get("ts")?.toString();
  const turnstileToken = formData.get("cf-turnstile-response")?.toString();

  if (!username || !encryptedPassword) {
    return c.html(html.loginForm("用户名和密码不能为空", c.env.TURNSTILE_SITE_KEY), 400);
  }

  // Verify Turnstile token
  if (!turnstileToken) {
    return c.html(html.loginForm("请完成人机验证", c.env.TURNSTILE_SITE_KEY), 400);
  }

  const remoteIp = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");
  const turnstileValid = await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET_KEY, remoteIp);

  if (!turnstileValid) {
    return c.html(html.loginForm("人机验证失败，请重试", c.env.TURNSTILE_SITE_KEY), 400);
  }

  // Validate request parameters
  if (!validateRequest(nonce || null, fingerprint || null, timestamp || null)) {
    return c.html(html.loginForm("请求参数无效", c.env.TURNSTILE_SITE_KEY), 400);
  }

  try {
    // Decrypt password
    const password = decryptPassword(encryptedPassword);

    const result = await c.env.DB.prepare(
      "SELECT * FROM users WHERE username = ?"
    ).bind(username).first();

    if (!result) {
      return c.html(html.loginForm("用户名或密码错误", c.env.TURNSTILE_SITE_KEY), 400);
    }

    const validPassword = await verifyPassword(password, result.hashed_password as string);

    if (!validPassword) {
      return c.html(html.loginForm("用户名或密码错误", c.env.TURNSTILE_SITE_KEY), 400);
    }

    const session = await lucia.createSession(result.id as string, {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

    return c.redirect("/");
  } catch (error) {
    console.error("Login error:", error);
    return c.html(html.loginForm("登录失败，请重试", c.env.TURNSTILE_SITE_KEY), 500);
  }
});

// Register page
app.get("/register", async (c) => {
  const user = c.get("user");
  if (user) {
    return c.redirect("/");
  }

  return c.html(html.registerForm(undefined, c.env.TURNSTILE_SITE_KEY));
});

// Register handler
app.post("/register", async (c) => {
  const lucia = initializeLucia(c.env.DB);
  const formData = await c.req.formData();
  const username = formData.get("username")?.toString();
  const email = formData.get("email")?.toString();
  const encryptedPassword = formData.get("p")?.toString();
  const displayName = formData.get("display_name")?.toString() || null;
  const nonce = formData.get("nonce")?.toString();
  const fingerprint = formData.get("fp")?.toString();
  const timestamp = formData.get("ts")?.toString();
  const turnstileToken = formData.get("cf-turnstile-response")?.toString();

  if (!username || !email || !encryptedPassword) {
    return c.html(html.registerForm("所有必填项不能为空", c.env.TURNSTILE_SITE_KEY), 400);
  }

  // Verify Turnstile token
  if (!turnstileToken) {
    return c.html(html.registerForm("请完成人机验证", c.env.TURNSTILE_SITE_KEY), 400);
  }

  const remoteIp = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");
  const turnstileValid = await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET_KEY, remoteIp);

  if (!turnstileValid) {
    return c.html(html.registerForm("人机验证失败，请重试", c.env.TURNSTILE_SITE_KEY), 400);
  }

  // Validate request parameters
  if (!validateRequest(nonce || null, fingerprint || null, timestamp || null)) {
    return c.html(html.registerForm("请求参数无效", c.env.TURNSTILE_SITE_KEY), 400);
  }

  try {
    // Decrypt password
    const password = decryptPassword(encryptedPassword);

    if (password.length < 8) {
      return c.html(html.registerForm("密码长度至少为 8 个字符", c.env.TURNSTILE_SITE_KEY), 400);
    }

    const existingUser = await c.env.DB.prepare(
      "SELECT id FROM users WHERE username = ? OR email = ?"
    ).bind(username, email).first();

    if (existingUser) {
      return c.html(html.registerForm("用户名或邮箱已被使用", c.env.TURNSTILE_SITE_KEY), 400);
    }

    const userId = generateId();
    const hashedPassword = await hashPassword(password);
    const now = Date.now();

    await c.env.DB.prepare(
      "INSERT INTO users (id, username, email, hashed_password, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, username, email, hashedPassword, displayName, now, now).run();

    const session = await lucia.createSession(userId, {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

    return c.redirect("/");
  } catch (error) {
    console.error("Registration error:", error);
    return c.html(html.registerForm("注册失败，请重试", c.env.TURNSTILE_SITE_KEY), 500);
  }
});

// Logout handler
app.post("/logout", async (c) => {
  const lucia = initializeLucia(c.env.DB);
  const session = c.get("session");

  if (session) {
    await lucia.invalidateSession(session.id);
  }

  const sessionCookie = lucia.createBlankSessionCookie();
  setCookie(c, sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

  return c.redirect("/login");
});

// OAuth authorization endpoint
app.get("/oauth/authorize", async (c) => {
  const user = c.get("user");

  if (!user) {
    const params = new URLSearchParams(c.req.query());
    return c.redirect(`/login?redirect=/oauth/authorize?${params.toString()}`);
  }

  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const responseType = c.req.query("response_type");
  const codeChallenge = c.req.query("code_challenge");
  const codeChallengeMethod = c.req.query("code_challenge_method") || "S256";

  if (!clientId || !redirectUri || responseType !== "code") {
    return c.text("Invalid request", 400);
  }

  // Validate PKCE parameters if provided
  if (codeChallenge && !validateCodeChallenge(codeChallenge, codeChallengeMethod)) {
    return c.text("Invalid code_challenge", 400);
  }

  const app = await c.env.DB.prepare(
    "SELECT * FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return c.text("Invalid client", 400);
  }

  const allowedUris = JSON.parse(app.redirect_uris as string);
  if (!allowedUris.includes(redirectUri)) {
    return c.text("Invalid redirect URI", 400);
  }

  // Store PKCE parameters in form (will be used in POST handler)
  return c.html(html.authorizePage(
    {
      name: app.name,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod
    },
    user
  ));
});

// OAuth authorization handler
app.post("/oauth/authorize", async (c) => {
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

    if (action === "deny") {
      return c.redirect(`${redirectUri}?error=access_denied`);
    }

    if (!clientId || !redirectUri) {
      return c.text("Invalid request", 400);
    }

    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store authorization code with PKCE challenge
    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, code_challenge, code_challenge_method) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, clientId, redirectUri, expiresAt, codeChallenge, codeChallengeMethod).run();

    return c.redirect(`${redirectUri}?code=${code}`);
  } catch (error) {
    console.error("OAuth authorize error:", error);
    return c.text("Internal Server Error", 500);
  }
});

// OAuth token endpoint
app.post("/oauth/token", async (c) => {
  const formData = await c.req.formData();
  const grantType = formData.get("grant_type")?.toString();
  const code = formData.get("code")?.toString();
  const clientId = formData.get("client_id")?.toString();
  const clientSecret = formData.get("client_secret")?.toString();
  const codeVerifier = formData.get("code_verifier")?.toString();

  if (grantType !== "authorization_code" || !code || !clientId) {
    return c.json({ error: "invalid_request" }, 400);
  }

  // 查找应用
  const app = await c.env.DB.prepare(
    "SELECT * FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return c.json({ error: "invalid_client" }, 401);
  }

  // 获取授权码
  const authCode = await c.env.DB.prepare(
    "SELECT * FROM auth_codes WHERE code = ? AND client_id = ?"
  ).bind(code, clientId).first();

  if (!authCode || (authCode.expires_at as number) < Date.now()) {
    return c.json({ error: "invalid_grant" }, 400);
  }

  // PKCE 验证
  const codeChallenge = authCode.code_challenge as string | null;
  const codeChallengeMethod = authCode.code_challenge_method as string | null;

  if (codeChallenge) {
    // 如果有 code_challenge，必须提供 code_verifier
    if (!codeVerifier) {
      return c.json({ error: "invalid_request", error_description: "code_verifier required" }, 400);
    }

    // 验证 code_verifier 格式
    if (!validateCodeVerifier(codeVerifier)) {
      return c.json({ error: "invalid_request", error_description: "invalid code_verifier" }, 400);
    }

    // 验证 PKCE
    const isValid = await verifyPKCE(codeVerifier, codeChallenge, codeChallengeMethod || "S256");
    if (!isValid) {
      return c.json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
    }
  } else {
    // 没有 PKCE，检查 client_secret（传统方式）
    const isPublicClient = !app.client_secret || app.client_secret === "public";

    if (!isPublicClient && app.client_secret !== clientSecret) {
      return c.json({ error: "invalid_client" }, 401);
    }
  }

  // 删除已使用的授权码
  await c.env.DB.prepare("DELETE FROM auth_codes WHERE code = ?").bind(code).run();

  // 创建会话
  const lucia = initializeLucia(c.env.DB);
  const session = await lucia.createSession(authCode.user_id as string, {});

  return c.json({
    access_token: session.id,
    token_type: "Bearer",
    expires_in: 3600
  });
});

// User info endpoint
app.get("/oauth/userinfo", async (c) => {
  const authorization = c.req.header("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authorization.substring(7);
  const lucia = initializeLucia(c.env.DB);
  const { user } = await lucia.validateSession(token);

  if (!user) {
    return c.json({ error: "invalid_token" }, 401);
  }

  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.displayName
  });
});

export default app;
