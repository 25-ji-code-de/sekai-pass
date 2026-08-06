import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizationUrl,
  createPKCEChallenge,
  isExternalProviderEnabled,
  listEnabledExternalProviders,
  sanitizeExternalLoginRedirect,
  sanitizeInternalRedirect,
} from "../src/lib/external-auth.ts";

describe("external auth provider registry", () => {
  test("only providers with both credentials are public", () => {
    const env = {
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "github-id",
    };
    assert.equal(isExternalProviderEnabled(env, "google"), true);
    assert.equal(isExternalProviderEnabled(env, "github"), false);
    assert.deepEqual(listEnabledExternalProviders(env).map((provider) => provider.id), ["google"]);
  });
});

describe("external auth flow values", () => {
  test("redirects are same-origin paths only", () => {
    assert.equal(sanitizeInternalRedirect("/settings?tab=login"), "/settings?tab=login");
    assert.equal(sanitizeInternalRedirect("https://attacker.example/"), "/");
    assert.equal(sanitizeInternalRedirect("//attacker.example/"), "/");
    assert.equal(sanitizeInternalRedirect("javascript:alert(1)"), "/");
  });

  test("login redirects cannot target protocol callbacks", () => {
    assert.equal(
      sanitizeExternalLoginRedirect("/api/auth/external/linuxdo/callback?code=one&state=two"),
      "/",
    );
    assert.equal(sanitizeExternalLoginRedirect("/settings"), "/settings");
  });

  test("PKCE challenge is RFC 7636 base64url", async () => {
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = await createPKCEChallenge(verifier);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  });

  test("authorization URL contains state, nonce and S256", () => {
    const url = new URL(buildAuthorizationUrl(
      { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" },
      "google",
      "https://pass.example/api/auth/external/google/callback",
      "state",
      "challenge",
      "nonce",
    ));
    assert.equal(url.searchParams.get("client_id"), "client");
    assert.equal(url.searchParams.get("state"), "state");
    assert.equal(url.searchParams.get("nonce"), "nonce");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });
});
