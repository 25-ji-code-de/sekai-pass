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


// ID Token Generation and Validation
// Implements OpenID Connect ID Token functionality

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { signJWT, verifyJWT, decodeJWT } from "./jwt.ts";
import { getCurrentSigningKey, getSigningKeyByKid } from "./keys.ts";
import { getClaimsForScope } from "./oidc-scope.ts";
import { SCOPES, hasScopes } from "./scope.ts";

export interface IDTokenClaims {
  // Required claims
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;

  // Optional claims
  auth_time?: number;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  bio?: string;
  email?: string;
  email_verified?: boolean;
  acr?: string;
  amr?: string[];
}

/**
 * Build ID token claims from user data
 */
export function buildIDTokenClaims(
  user: any,
  clientId: string,
  issuer: string,
  nonce: string | null,
  authTime: number,
  scope: string
): IDTokenClaims {
  const now = Math.floor(Date.now() / 1000);

  const claims: IDTokenClaims = {
    iss: issuer,
    sub: user.id,
    aud: clientId,
    exp: now + 3600, // 1 hour
    iat: now,
    auth_time: Math.floor(authTime / 1000)
  };

  // Add nonce if provided
  if (nonce) {
    claims.nonce = nonce;
  }

  // Add claims based on scope
  if (hasScopes(scope, [SCOPES.PROFILE])) {
    claims.name = user.display_name;
    claims.preferred_username = user.username;
    if (user.avatar_url) {
      claims.picture = user.avatar_url;
    }
    if (user.bio) {
      claims.bio = user.bio;
    }
  }

  if (hasScopes(scope, [SCOPES.EMAIL])) {
    claims.email = user.email;
    claims.email_verified = true; // Assuming verified
  }

  // Add authentication context
  claims.acr = "urn:mace:incommon:iap:silver";
  claims.amr = ["pwd"]; // Password authentication

  return claims;
}

/**
 * Generate ID token
 */
export async function generateIDToken(
  db: D1Database,
  kv: KVNamespace,
  user: any,
  clientId: string,
  nonce: string | null,
  authTime: number,
  scope: string,
  issuer: string,
  encryptionKey: string
): Promise<string> {
  // Get current signing key
  const signingKey = await getCurrentSigningKey(db, kv, encryptionKey);

  if (!signingKey) {
    throw new Error("No signing key available");
  }

  // Build claims
  const claims = buildIDTokenClaims(
    user,
    clientId,
    issuer,
    nonce,
    authTime,
    scope
  );

  // Sign JWT
  return await signJWT(claims, signingKey.privateKeyJWK, signingKey.kid);
}

/**
 * Validate ID token
 */
export async function validateIDToken(
  token: string,
  db: D1Database,
  expectedIssuer: string,
  expectedAudience: string
): Promise<{ valid: boolean; claims?: IDTokenClaims; error?: string }> {
  // Decode token
  const decoded = decodeJWT(token);

  if (!decoded) {
    return { valid: false, error: "Invalid token format" };
  }

  // Get signing key
  const kid = decoded.header.kid;
  if (!kid) {
    return { valid: false, error: "Missing kid in token header" };
  }

  const publicKey = await getSigningKeyByKid(db, kid);
  if (!publicKey) {
    return { valid: false, error: "Unknown signing key" };
  }

  // Verify signature
  const signatureValid = await verifyJWT(token, publicKey);
  if (!signatureValid) {
    return { valid: false, error: "Invalid signature" };
  }

  const claims = decoded.payload as IDTokenClaims;

  // Validate issuer
  if (claims.iss !== expectedIssuer) {
    return { valid: false, error: "Invalid issuer" };
  }

  // Validate audience
  if (claims.aud !== expectedAudience) {
    return { valid: false, error: "Invalid audience" };
  }

  // Validate expiration
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    return { valid: false, error: "Token expired" };
  }

  // Validate issued at (not in future)
  if (claims.iat > now + 60) { // Allow 60 second clock skew
    return { valid: false, error: "Token issued in future" };
  }

  return { valid: true, claims };
}
