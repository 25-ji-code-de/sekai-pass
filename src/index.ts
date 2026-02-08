import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { initializeLucia } from "./lib/auth";
import { generateId } from "./lib/password";
import { verifyPKCE, validateCodeChallenge, validateCodeVerifier } from "./lib/pkce";
import { verifyTurnstile } from "./lib/turnstile";
import * as html from "./lib/html";
import { apiRouter } from "./lib/api";

type Bindings = {
  DB: D1Database;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
  ASSETS: Fetcher;
};

type Variables = {
  user: any | null;
  session: any | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
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

  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${baseUrl}/docs`,
    ui_locales_supported: ["zh-CN", "en-US"],
    // OAuth 2.1: PKCE is mandatory
    require_pushed_authorization_requests: false,
    require_request_uri_registration: false
  });
});

// OAuth authorization endpoint (traditional flow with HTML)
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
  const state = c.req.query("state");

  if (!clientId || !redirectUri || responseType !== "code") {
    return c.text("Invalid request", 400);
  }

  // OAuth 2.1: PKCE is mandatory for all clients
  if (!codeChallenge) {
    return c.text("code_challenge is required (PKCE mandatory)", 400);
  }

  if (!validateCodeChallenge(codeChallenge, codeChallengeMethod)) {
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

  return c.html(html.authorizePage(
    {
      name: app.name,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state: state
    },
    user
  ));
});

// OAuth authorization handler (traditional flow)
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
    const state = formData.get("state")?.toString() || null;

    if (action === "deny") {
      const errorUrl = new URL(redirectUri!);
      errorUrl.searchParams.set("error", "access_denied");
      if (state) {
        errorUrl.searchParams.set("state", state);
      }
      return c.redirect(errorUrl.toString());
    }

    if (!clientId || !redirectUri) {
      return c.text("Invalid request", 400);
    }

    const code = generateId(32);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    await c.env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, expires_at, code_challenge, code_challenge_method, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(code, user.id, clientId, redirectUri, expiresAt, codeChallenge, codeChallengeMethod, state).run();

    const successUrl = new URL(redirectUri);
    successUrl.searchParams.set("code", code);
    if (state) {
      successUrl.searchParams.set("state", state);
    }
    return c.redirect(successUrl.toString());
  } catch (error) {
    console.error("OAuth authorize error:", error);
    return c.text("Internal Server Error", 500);
  }
});

// OAuth token endpoint (standard OAuth 2.0)
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

  const app = await c.env.DB.prepare(
    "SELECT * FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return c.json({ error: "invalid_client" }, 401);
  }

  const authCode = await c.env.DB.prepare(
    "SELECT * FROM auth_codes WHERE code = ? AND client_id = ?"
  ).bind(code, clientId).first();

  if (!authCode || (authCode.expires_at as number) < Date.now()) {
    return c.json({ error: "invalid_grant" }, 400);
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

  await c.env.DB.prepare("DELETE FROM auth_codes WHERE code = ?").bind(code).run();

  const lucia = initializeLucia(c.env.DB);
  const session = await lucia.createSession(authCode.user_id as string, {});

  return c.json({
    access_token: session.id,
    token_type: "Bearer",
    expires_in: 3600
  });
});

// User info endpoint (standard OAuth 2.0)
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

export default app;
