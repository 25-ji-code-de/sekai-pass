/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const EXTERNAL_PROVIDER_IDS = ["google", "microsoft", "github", "x", "linuxdo"] as const;
export type ExternalProviderId = (typeof EXTERNAL_PROVIDER_IDS)[number];

export type ExternalAuthEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  LINUXDO_CLIENT_ID?: string;
  LINUXDO_CLIENT_SECRET?: string;
};

export type ExternalIdentity = {
  provider: ExternalProviderId;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

type ProviderDefinition = {
  id: ExternalProviderId;
  name: string;
  icon: string;
  clientIdKey: keyof ExternalAuthEnv;
  clientSecretKey: keyof ExternalAuthEnv;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  tokenAuth?: "body" | "basic";
  oidc?: {
    issuer: string | RegExp;
    jwksUri: string;
  };
};

const PROVIDERS: Record<ExternalProviderId, ProviderDefinition> = {
  google: {
    id: "google",
    name: "Google",
    icon: "/images/providers/google.svg",
    clientIdKey: "GOOGLE_CLIENT_ID",
    clientSecretKey: "GOOGLE_CLIENT_SECRET",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "profile", "email"],
    oidc: {
      issuer: /^(https:\/\/accounts\.google\.com|accounts\.google\.com)$/,
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    },
  },
  microsoft: {
    id: "microsoft",
    name: "Microsoft",
    icon: "/images/providers/microsoft.svg",
    clientIdKey: "MICROSOFT_CLIENT_ID",
    clientSecretKey: "MICROSOFT_CLIENT_SECRET",
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["openid", "profile", "email"],
    oidc: {
      issuer: /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0$/i,
      jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    },
  },
  github: {
    id: "github",
    name: "GitHub",
    icon: "/images/providers/github.svg",
    clientIdKey: "GITHUB_CLIENT_ID",
    clientSecretKey: "GITHUB_CLIENT_SECRET",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "user:email"],
  },
  x: {
    id: "x",
    name: "X",
    icon: "/images/providers/x.svg",
    clientIdKey: "X_CLIENT_ID",
    clientSecretKey: "X_CLIENT_SECRET",
    authorizationEndpoint: "https://x.com/i/oauth2/authorize",
    tokenEndpoint: "https://api.x.com/2/oauth2/token",
    scopes: ["users.read", "tweet.read"],
    tokenAuth: "basic",
  },
  linuxdo: {
    id: "linuxdo",
    name: "Linux DO",
    icon: "/images/providers/linuxdo.svg",
    clientIdKey: "LINUXDO_CLIENT_ID",
    clientSecretKey: "LINUXDO_CLIENT_SECRET",
    authorizationEndpoint: "https://connect.linux.do/oauth2/authorize",
    tokenEndpoint: "https://connect.linux.do/oauth2/token",
    scopes: ["openid", "profile", "email"],
    oidc: {
      issuer: "https://connect.linux.do/",
      jwksUri: "https://connect.linux.do/.well-known/jwks.json",
    },
  },
};

export function isExternalProviderId(value: string): value is ExternalProviderId {
  return (EXTERNAL_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getExternalProvider(id: ExternalProviderId): ProviderDefinition {
  return PROVIDERS[id];
}

export function providerCredentials(env: ExternalAuthEnv, id: ExternalProviderId) {
  const provider = PROVIDERS[id];
  return {
    clientId: String(env[provider.clientIdKey] || "").trim(),
    clientSecret: String(env[provider.clientSecretKey] || "").trim(),
  };
}

export function isExternalProviderEnabled(env: ExternalAuthEnv, id: ExternalProviderId): boolean {
  const { clientId, clientSecret } = providerCredentials(env, id);
  return Boolean(clientId && clientSecret);
}

export function listEnabledExternalProviders(env: ExternalAuthEnv) {
  return EXTERNAL_PROVIDER_IDS
    .filter((id) => isExternalProviderEnabled(env, id))
    .map((id) => ({ id, name: PROVIDERS[id].name, icon: PROVIDERS[id].icon }));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomOAuthValue(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPKCEChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function sanitizeInternalRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://sekai-pass.invalid");
    if (parsed.origin !== "https://sekai-pass.invalid") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

// Browser login flows must never return to a protocol callback or API route.
// Those URLs contain one-time credentials and are not user-facing destinations.
export function sanitizeExternalLoginRedirect(value: unknown): string {
  const redirect = sanitizeInternalRedirect(value);
  const path = new URL(redirect, "https://sekai-pass.invalid").pathname;
  if (path.startsWith("/api/") || path === "/oauth/authorize") return "/";
  return redirect;
}

export function buildAuthorizationUrl(
  env: ExternalAuthEnv,
  id: ExternalProviderId,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  nonce: string,
): string {
  const provider = PROVIDERS[id];
  const { clientId } = providerCredentials(env, id);
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (provider.oidc) url.searchParams.set("nonce", nonce);
  return url.toString();
}

type TokenResponse = { access_token?: unknown; id_token?: unknown; token_type?: unknown };

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok || !body) throw new Error(`Upstream request failed (${response.status})`);
  return body;
}

export async function exchangeAuthorizationCode(
  env: ExternalAuthEnv,
  id: ExternalProviderId,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{ accessToken: string; idToken: string | null }> {
  const provider = PROVIDERS[id];
  const { clientId, clientSecret } = providerCredentials(env, id);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: clientId,
  });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (provider.tokenAuth === "basic") {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else {
    body.set("client_secret", clientSecret);
  }

  const token = await fetchJson(provider.tokenEndpoint, { method: "POST", headers, body }) as TokenResponse;
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("Upstream token response did not include an access token");
  }
  return {
    accessToken: token.access_token,
    idToken: typeof token.id_token === "string" ? token.id_token : null,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function verifiedEmail(payload: JWTPayload): { email: string | null; verified: boolean } {
  return {
    email: optionalString(payload.email),
    verified: payload.email_verified === true,
  };
}

async function identityFromOIDC(
  env: ExternalAuthEnv,
  id: ExternalProviderId,
  idToken: string | null,
  nonce: string,
): Promise<ExternalIdentity> {
  if (!idToken) throw new Error("OIDC provider did not return an ID token");
  const provider = PROVIDERS[id];
  const oidc = provider.oidc!;
  const { clientId } = providerCredentials(env, id);
  const jwks = createRemoteJWKSet(new URL(oidc.jwksUri));
  const { payload } = await jwtVerify(idToken, jwks, {
    audience: clientId,
    algorithms: ["RS256"],
  });
  if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Invalid OIDC nonce or subject");
  }
  const issuerValid = typeof oidc.issuer === "string"
    ? payload.iss === oidc.issuer
    : typeof payload.iss === "string" && oidc.issuer.test(payload.iss);
  if (!issuerValid) throw new Error("Invalid OIDC issuer");

  const email = verifiedEmail(payload);
  return {
    provider: id,
    subject: payload.sub,
    email: email.email,
    emailVerified: email.verified,
    displayName: optionalString(payload.name)
      || optionalString(payload.preferred_username)
      || optionalString(payload.username)
      || optionalString(payload.login),
    avatarUrl: optionalString(payload.picture) || optionalString(payload.avatar_url),
  };
}

async function identityFromGitHub(accessToken: string): Promise<ExternalIdentity> {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const [profile, emails] = await Promise.all([
    fetchJson("https://api.github.com/user", { headers }),
    fetchJson("https://api.github.com/user/emails", { headers }).catch(() => []),
  ]);
  if (typeof profile.id !== "number" && typeof profile.id !== "string") {
    throw new Error("GitHub profile did not include an id");
  }
  const list = Array.isArray(emails) ? emails : [];
  const chosen = list.find((item) => item?.primary === true && item?.verified === true)
    || list.find((item) => item?.verified === true);
  return {
    provider: "github",
    subject: String(profile.id),
    email: optionalString(chosen?.email),
    emailVerified: Boolean(chosen?.verified),
    displayName: optionalString(profile.name) || optionalString(profile.login),
    avatarUrl: optionalString(profile.avatar_url),
  };
}

async function identityFromX(accessToken: string): Promise<ExternalIdentity> {
  const response = await fetchJson(
    "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const profile = response.data;
  if (!profile || (typeof profile.id !== "string" && typeof profile.id !== "number")) {
    throw new Error("X profile did not include an id");
  }
  return {
    provider: "x",
    subject: String(profile.id),
    email: null,
    emailVerified: false,
    displayName: optionalString(profile.name) || optionalString(profile.username),
    avatarUrl: optionalString(profile.profile_image_url),
  };
}

export async function resolveExternalIdentity(
  env: ExternalAuthEnv,
  id: ExternalProviderId,
  accessToken: string,
  idToken: string | null,
  nonce: string,
): Promise<ExternalIdentity> {
  if (id === "github") return identityFromGitHub(accessToken);
  if (id === "x") return identityFromX(accessToken);
  return identityFromOIDC(env, id, idToken, nonce);
}
