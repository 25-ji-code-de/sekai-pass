// OAuth 2.1 Token Management
// Short-lived access tokens (1 hour) and long-lived refresh tokens (30 days)

import type { D1Database } from "@cloudflare/workers-types";
import { generateId } from "./password";

export interface TokenPair {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  id_token?: string; // Optional ID token for OIDC
}

export interface AccessTokenInfo {
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
}

/**
 * Generate access token and refresh token pair
 */
export async function issueTokens(
  db: D1Database,
  userId: string,
  clientId: string,
  scope: string = "profile",
  idToken?: string
): Promise<TokenPair> {
  // Generate access token (1 hour)
  const accessToken = generateId(32);
  const accessExpiresAt = Date.now() + 3600 * 1000; // 1 hour

  await db.prepare(
    "INSERT INTO access_tokens (token, user_id, client_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(accessToken, userId, clientId, scope, accessExpiresAt, Date.now()).run();

  // Generate refresh token (30 days)
  const refreshToken = generateId(32);
  const refreshExpiresAt = Date.now() + 30 * 24 * 3600 * 1000; // 30 days

  await db.prepare(
    "INSERT INTO refresh_tokens (token, user_id, client_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(refreshToken, userId, clientId, scope, refreshExpiresAt, Date.now()).run();

  const tokenPair: TokenPair = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: scope
  };

  // Add ID token if provided
  if (idToken) {
    tokenPair.id_token = idToken;
  }

  return tokenPair;
}

/**
 * Validate access token and return token info
 */
export async function validateAccessToken(
  db: D1Database,
  token: string
): Promise<AccessTokenInfo | null> {
  const result = await db.prepare(
    "SELECT user_id, client_id, scope, expires_at FROM access_tokens WHERE token = ? AND expires_at > ?"
  ).bind(token, Date.now()).first();

  if (!result) {
    return null;
  }

  return {
    userId: result.user_id as string,
    clientId: result.client_id as string,
    scope: result.scope as string,
    expiresAt: result.expires_at as number
  };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  db: D1Database,
  refreshToken: string
): Promise<TokenPair | null> {
  // Validate refresh token
  const result = await db.prepare(
    "SELECT user_id, client_id, scope, expires_at FROM refresh_tokens WHERE token = ? AND expires_at > ?"
  ).bind(refreshToken, Date.now()).first();

  if (!result) {
    return null;
  }

  const userId = result.user_id as string;
  const clientId = result.client_id as string;
  const scope = result.scope as string;

  // Generate new access token
  const newAccessToken = generateId(32);
  const accessExpiresAt = Date.now() + 3600 * 1000; // 1 hour

  await db.prepare(
    "INSERT INTO access_tokens (token, user_id, client_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(newAccessToken, userId, clientId, scope, accessExpiresAt, Date.now()).run();

  // Token rotation: generate new refresh token
  const newRefreshToken = generateId(32);
  const refreshExpiresAt = Date.now() + 30 * 24 * 3600 * 1000; // 30 days

  // Delete old refresh token and insert new one (atomic operation)
  await db.batch([
    db.prepare("DELETE FROM refresh_tokens WHERE token = ?").bind(refreshToken),
    db.prepare(
      "INSERT INTO refresh_tokens (token, user_id, client_id, scope, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(newRefreshToken, userId, clientId, scope, refreshExpiresAt, Date.now(), Date.now())
  ]);

  return {
    access_token: newAccessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: newRefreshToken,
    scope: scope
  };
}

/**
 * Revoke access token
 */
export async function revokeAccessToken(
  db: D1Database,
  token: string
): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM access_tokens WHERE token = ?"
  ).bind(token).run();

  return result.success;
}

/**
 * Revoke refresh token (and optionally all associated access tokens)
 */
export async function revokeRefreshToken(
  db: D1Database,
  token: string,
  revokeAccessTokens: boolean = false
): Promise<boolean> {
  if (revokeAccessTokens) {
    // Get user_id and client_id from refresh token
    const refreshTokenInfo = await db.prepare(
      "SELECT user_id, client_id FROM refresh_tokens WHERE token = ?"
    ).bind(token).first();

    if (refreshTokenInfo) {
      // Delete all access tokens for this user and client
      await db.prepare(
        "DELETE FROM access_tokens WHERE user_id = ? AND client_id = ?"
      ).bind(refreshTokenInfo.user_id, refreshTokenInfo.client_id).run();
    }
  }

  const result = await db.prepare(
    "DELETE FROM refresh_tokens WHERE token = ?"
  ).bind(token).run();

  return result.success;
}

/**
 * Revoke all tokens for a user (logout from all devices)
 */
export async function revokeAllUserTokens(
  db: D1Database,
  userId: string,
  clientId?: string
): Promise<void> {
  if (clientId) {
    // Revoke tokens for specific client
    await db.batch([
      db.prepare("DELETE FROM access_tokens WHERE user_id = ? AND client_id = ?").bind(userId, clientId),
      db.prepare("DELETE FROM refresh_tokens WHERE user_id = ? AND client_id = ?").bind(userId, clientId)
    ]);
  } else {
    // Revoke all tokens for user
    await db.batch([
      db.prepare("DELETE FROM access_tokens WHERE user_id = ?").bind(userId),
      db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").bind(userId)
    ]);
  }
}

/**
 * Clean up expired tokens (should be run periodically)
 */
export async function cleanupExpiredTokens(db: D1Database): Promise<void> {
  const now = Date.now();

  await db.batch([
    db.prepare("DELETE FROM access_tokens WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM jwt_replay_cache WHERE expires_at < ?").bind(now)
  ]);
}

/**
 * Get user's active tokens
 */
export async function getUserTokens(
  db: D1Database,
  userId: string
): Promise<{ accessTokens: any[], refreshTokens: any[] }> {
  const accessTokens = await db.prepare(
    "SELECT token, client_id, scope, expires_at, created_at FROM access_tokens WHERE user_id = ? AND expires_at > ?"
  ).bind(userId, Date.now()).all();

  const refreshTokens = await db.prepare(
    "SELECT token, client_id, scope, expires_at, created_at, last_used_at FROM refresh_tokens WHERE user_id = ? AND expires_at > ?"
  ).bind(userId, Date.now()).all();

  return {
    accessTokens: accessTokens.results || [],
    refreshTokens: refreshTokens.results || []
  };
}
