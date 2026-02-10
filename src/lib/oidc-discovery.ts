// OpenID Connect Discovery Metadata
// Generates OIDC discovery document per OpenID Connect Discovery 1.0

import { SCOPES } from "./scope";

export interface OIDCMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  token_endpoint_auth_signing_alg_values_supported: string[];
  scopes_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  claims_supported: string[];
  code_challenge_methods_supported: string[];
  service_documentation?: string;
  ui_locales_supported?: string[];
}

/**
 * Generate OIDC discovery metadata
 */
export function generateOIDCMetadata(baseUrl: string): OIDCMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,

    // Response types
    response_types_supported: ["code"],

    // Grant types
    grant_types_supported: ["authorization_code", "refresh_token"],

    // Subject types
    subject_types_supported: ["public"],

    // Signing algorithms
    id_token_signing_alg_values_supported: ["ES256", "RS256"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256", "RS256"],

    // Scopes
    scopes_supported: ["openid", ...Object.values(SCOPES)],

    // Authentication methods
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],

    // Claims
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "name",
      "preferred_username",
      "email",
      "email_verified",
      "acr",
      "amr"
    ],

    // PKCE - OAuth 2.1: Only S256 method is supported
    code_challenge_methods_supported: ["S256"],

    // Optional metadata
    service_documentation: `${baseUrl}/docs`,
    ui_locales_supported: ["zh-CN", "en-US"]
  };
}
