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


// OIDC Scope Handling
// Maps OIDC scopes to claims and validates OIDC requests

import { SCOPES, parseScopes, type Scope } from "./scope";

/**
 * Check if request includes openid scope
 */
export function isOIDCRequest(scopeString: string | null | undefined): boolean {
  if (!scopeString) {
    return false;
  }

  const scopes = scopeString.split(/\s+/).filter(s => s.length > 0);
  return scopes.includes("openid");
}

/**
 * Get claims for given scope
 */
export function getClaimsForScope(scopeString: string): string[] {
  const scopes = parseScopes(scopeString);
  const claims: string[] = ["sub"]; // sub is always included

  for (const scope of scopes) {
    switch (scope) {
      case SCOPES.PROFILE:
        claims.push("name", "preferred_username", "picture", "bio");
        break;
      case SCOPES.EMAIL:
        claims.push("email", "email_verified");
        break;
      // applications and admin scopes don't add claims to ID token
    }
  }

  // Check for openid scope
  if (isOIDCRequest(scopeString)) {
    // OpenID scope adds auth_time
    if (!claims.includes("auth_time")) {
      claims.push("auth_time");
    }
  }

  return [...new Set(claims)]; // Remove duplicates
}

/**
 * Validate OIDC scope parameter
 */
export function validateOIDCScope(scopeParam: string | null | undefined): {
  valid: boolean;
  error?: string;
} {
  if (!scopeParam) {
    return {
      valid: false,
      error: "scope parameter is required for OIDC requests"
    };
  }

  if (!isOIDCRequest(scopeParam)) {
    return {
      valid: false,
      error: "openid scope is required for OIDC requests"
    };
  }

  return { valid: true };
}
