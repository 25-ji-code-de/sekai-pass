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


// OAuth 2.1 Scope Validation Middleware
// Provides fine-grained access control for different endpoints

import type { Context, Next } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import { validateAccessToken } from "./tokens";

/**
 * Supported OAuth scopes
 */
export const SCOPES = {
  OPENID: "openid",          // OpenID Connect authentication
  PROFILE: "profile",        // Basic user profile (id, username, display_name)
  EMAIL: "email",            // User email address
  APPLICATIONS: "applications", // Manage OAuth applications
  ADMIN: "admin"             // Administrative access
} as const;

export type Scope = typeof SCOPES[keyof typeof SCOPES];

/**
 * Scope descriptions for authorization page
 */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  [SCOPES.OPENID]: "OpenID Connect 身份验证",
  [SCOPES.PROFILE]: "访问您的基本信息（用户名、显示名称、头像、个性签名）",
  [SCOPES.EMAIL]: "访问您的电子邮件地址",
  [SCOPES.APPLICATIONS]: "管理您的 OAuth 应用程序",
  [SCOPES.ADMIN]: "管理员权限"
};

/**
 * Parse scope string into array
 */
export function parseScopes(scopeString: string | null | undefined): Scope[] {
  if (!scopeString) {
    return [SCOPES.PROFILE]; // Default scope
  }

  const scopes = scopeString.split(/\s+/).filter(s => s.length > 0);
  return scopes.filter(s => Object.values(SCOPES).includes(s as Scope)) as Scope[];
}

/**
 * Convert scope array to string
 */
export function formatScopes(scopes: Scope[]): string {
  return scopes.join(" ");
}

/**
 * Check if granted scopes include all required scopes
 */
export function hasScopes(granted: string, required: Scope[]): boolean {
  const grantedScopes = parseScopes(granted);

  // Admin scope grants all permissions
  if (grantedScopes.includes(SCOPES.ADMIN)) {
    return true;
  }

  return required.every(scope => grantedScopes.includes(scope));
}

/**
 * Middleware to require specific scopes
 *
 * Usage:
 * app.get("/api/profile", requireScopes([SCOPES.PROFILE]), async (c) => { ... });
 */
export function requireScopes(requiredScopes: Scope[]) {
  return async (c: Context, next: Next) => {
    const authorization = c.req.header("Authorization");

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return c.json({
        error: "unauthorized",
        error_description: "Missing or invalid Authorization header"
      }, 401);
    }

    const token = authorization.substring(7);
    const db = c.env.DB as D1Database;

    // Validate access token
    const tokenInfo = await validateAccessToken(db, token);

    if (!tokenInfo) {
      return c.json({
        error: "invalid_token",
        error_description: "Access token is invalid or expired"
      }, 401);
    }

    // Check scopes
    if (!hasScopes(tokenInfo.scope, requiredScopes)) {
      return c.json({
        error: "insufficient_scope",
        error_description: `This endpoint requires scopes: ${formatScopes(requiredScopes)}`,
        scope: formatScopes(requiredScopes)
      }, 403);
    }

    // Store token info in context for later use
    c.set("tokenInfo", tokenInfo);

    await next();
  };
}

/**
 * Validate scope parameter from authorization request
 */
export function validateScopeParameter(scopeParam: string | null | undefined): {
  valid: boolean;
  scopes: Scope[];
  error?: string;
} {
  const scopes = parseScopes(scopeParam);

  if (scopes.length === 0) {
    return {
      valid: true,
      scopes: [SCOPES.PROFILE] // Default scope
    };
  }

  // Check for invalid scopes
  const requestedScopes = scopeParam?.split(/\s+/).filter(s => s.length > 0) || [];
  const invalidScopes = requestedScopes.filter(s => !Object.values(SCOPES).includes(s as Scope));

  if (invalidScopes.length > 0) {
    return {
      valid: false,
      scopes: [],
      error: `Invalid scopes: ${invalidScopes.join(", ")}`
    };
  }

  return {
    valid: true,
    scopes
  };
}

/**
 * Filter user data based on granted scopes
 */
export function filterUserData(user: any, scopes: string): any {
  const grantedScopes = parseScopes(scopes);
  const filtered: any = {};

  // Profile scope: basic info
  if (grantedScopes.includes(SCOPES.PROFILE)) {
    filtered.id = user.id;
    filtered.username = user.username;
    filtered.display_name = user.display_name;
    if (user.avatar_url) filtered.avatar_url = user.avatar_url;
    if (user.bio) filtered.bio = user.bio;
  }

  // Email scope: email address
  if (grantedScopes.includes(SCOPES.EMAIL)) {
    filtered.email = user.email;
  }

  return filtered;
}
