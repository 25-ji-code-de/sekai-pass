// Client Authentication Module (RFC 7523)
// Implements Private Key JWT client authentication for OAuth 2.1

import { decodeJWT, base64URLDecode } from "./jwt";

export interface AuthenticationResult {
  authenticated: boolean;
  clientId?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Main entry point for client authentication
 * Routes to appropriate authentication method based on client configuration
 */
export async function authenticateClient(
  db: D1Database,
  formData: FormData,
  tokenEndpointUrl: string
): Promise<AuthenticationResult> {
  const clientId = formData.get("client_id")?.toString();

  if (!clientId) {
    return {
      authenticated: false,
      error: "invalid_request",
      errorDescription: "client_id is required"
    };
  }

  // Get client configuration
  const app = await db.prepare(
    "SELECT client_id, token_endpoint_auth_method FROM applications WHERE client_id = ?"
  ).bind(clientId).first();

  if (!app) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "Client not found"
    };
  }

  const authMethod = (app.token_endpoint_auth_method as string) || "none";

  // Route to appropriate authentication method
  switch (authMethod) {
    case "none":
      // Public client - no authentication required
      return {
        authenticated: true,
        clientId: clientId
      };

    case "private_key_jwt":
      const clientAssertion = formData.get("client_assertion")?.toString();
      const clientAssertionType = formData.get("client_assertion_type")?.toString();

      if (!clientAssertion || !clientAssertionType) {
        return {
          authenticated: false,
          error: "invalid_request",
          errorDescription: "client_assertion and client_assertion_type are required for private_key_jwt authentication"
        };
      }

      return await authenticateClientWithJWT(
        db,
        clientAssertion,
        clientAssertionType,
        tokenEndpointUrl,
        clientId
      );

    default:
      return {
        authenticated: false,
        error: "invalid_client",
        errorDescription: `Unsupported authentication method: ${authMethod}`
      };
  }
}

/**
 * Authenticate client using JWT assertion (RFC 7523)
 */
async function authenticateClientWithJWT(
  db: D1Database,
  clientAssertion: string,
  clientAssertionType: string,
  tokenEndpointUrl: string,
  clientId: string
): Promise<AuthenticationResult> {
  // Validate assertion type
  if (clientAssertionType !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
    return {
      authenticated: false,
      error: "invalid_request",
      errorDescription: "Invalid client_assertion_type. Must be 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'"
    };
  }

  // Decode JWT (without verification)
  const decoded = decodeJWT(clientAssertion);
  if (!decoded) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "Invalid JWT format"
    };
  }

  const { header, payload } = decoded;

  // Validate required claims (RFC 7523 Section 3)
  const requiredClaims = ["iss", "sub", "aud", "exp", "jti"];
  for (const claim of requiredClaims) {
    if (!payload[claim]) {
      return {
        authenticated: false,
        error: "invalid_client",
        errorDescription: `Missing required claim: ${claim}`
      };
    }
  }

  // Validate issuer and subject match client_id (RFC 7523 Section 3)
  if (payload.iss !== clientId || payload.sub !== clientId) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "JWT iss and sub must equal client_id"
    };
  }

  // Validate audience (must match token endpoint)
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(tokenEndpointUrl)) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: `Invalid audience. Expected: ${tokenEndpointUrl}`
    };
  }

  // Validate expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "JWT has expired"
    };
  }

  // Validate expiration is not too far in the future (max 1 hour)
  if (payload.exp > now + 3600) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "JWT expiration is too far in the future (max 1 hour)"
    };
  }

  // Validate issued at time (if present) with clock skew tolerance
  if (payload.iat && payload.iat > now + 60) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "JWT issued in the future"
    };
  }

  // Check for JWT replay attack
  const replayCheck = await checkJWTReplay(db, payload.jti, clientId);
  if (!replayCheck.valid) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: replayCheck.error || "JWT replay detected"
    };
  }

  // Get client's public key
  const kid = header.kid;
  if (!kid) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "JWT header must include 'kid' (key ID)"
    };
  }

  const keyResult = await getClientPublicKey(db, clientId, kid);
  if (!keyResult.valid) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: keyResult.error || "Public key not found"
    };
  }

  // Verify JWT signature
  const signatureValid = await verifyJWTSignature(
    clientAssertion,
    keyResult.publicKeyJWK!,
    keyResult.algorithm!
  );

  if (!signatureValid) {
    return {
      authenticated: false,
      error: "invalid_client",
      errorDescription: "Invalid JWT signature"
    };
  }

  // Store JTI to prevent replay
  await storeJTI(db, payload.jti, clientId, payload.exp);

  // Authentication successful
  return {
    authenticated: true,
    clientId: clientId
  };
}

/**
 * Verify JWT signature using client's public key
 * Supports ES256 and RS256 algorithms
 */
async function verifyJWTSignature(
  token: string,
  publicKeyJWK: JsonWebKey,
  algorithm: string
): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    // Import public key based on algorithm
    let publicKey: CryptoKey;
    let verifyAlgorithm: any;

    if (algorithm === "ES256") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        publicKeyJWK,
        {
          name: "ECDSA",
          namedCurve: "P-256"
        },
        false,
        ["verify"]
      );
      verifyAlgorithm = {
        name: "ECDSA",
        hash: { name: "SHA-256" }
      };
    } else if (algorithm === "RS256") {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        publicKeyJWK,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256"
        },
        false,
        ["verify"]
      );
      verifyAlgorithm = {
        name: "RSASSA-PKCS1-v1_5"
      };
    } else {
      console.error(`Unsupported algorithm: ${algorithm}`);
      return false;
    }

    // Decode signature
    const signature = base64URLDecode(encodedSignature);

    // Create signing input
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signingInputBuffer = new TextEncoder().encode(signingInput);

    // Verify signature
    return await crypto.subtle.verify(
      verifyAlgorithm,
      publicKey,
      signature,
      signingInputBuffer
    );
  } catch (error) {
    console.error("JWT signature verification error:", error);
    return false;
  }
}

/**
 * Get client's public key from database
 */
async function getClientPublicKey(
  db: D1Database,
  clientId: string,
  kid: string
): Promise<{
  valid: boolean;
  publicKeyJWK?: JsonWebKey;
  algorithm?: string;
  error?: string;
}> {
  try {
    const key = await db.prepare(
      "SELECT public_key_jwk, algorithm FROM client_keys WHERE client_id = ? AND key_id = ? AND status = 'active'"
    ).bind(clientId, kid).first();

    if (!key) {
      return {
        valid: false,
        error: `Public key not found for client_id=${clientId}, kid=${kid}`
      };
    }

    const publicKeyJWK = JSON.parse(key.public_key_jwk as string);
    const algorithm = key.algorithm as string;

    return {
      valid: true,
      publicKeyJWK,
      algorithm
    };
  } catch (error) {
    console.error("Error retrieving client public key:", error);
    return {
      valid: false,
      error: "Failed to retrieve public key"
    };
  }
}

/**
 * Check if JWT has already been used (replay attack prevention)
 */
async function checkJWTReplay(
  db: D1Database,
  jti: string,
  clientId: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    const existing = await db.prepare(
      "SELECT jti FROM jwt_replay_cache WHERE jti = ? AND client_id = ?"
    ).bind(jti, clientId).first();

    if (existing) {
      return {
        valid: false,
        error: "JWT has already been used (replay detected)"
      };
    }

    return { valid: true };
  } catch (error) {
    console.error("Error checking JWT replay:", error);
    return {
      valid: false,
      error: "Failed to check JWT replay"
    };
  }
}

/**
 * Store JTI to prevent replay attacks
 */
async function storeJTI(
  db: D1Database,
  jti: string,
  clientId: string,
  exp: number
): Promise<void> {
  try {
    const now = Date.now();
    const expiresAt = exp * 1000; // Convert to milliseconds

    await db.prepare(
      "INSERT INTO jwt_replay_cache (jti, client_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(jti, clientId, expiresAt, now).run();
  } catch (error) {
    console.error("Error storing JTI:", error);
    // Don't fail authentication if storage fails, but log the error
  }
}

/**
 * Cleanup expired JTIs from replay cache
 * Called during token cleanup
 */
export async function cleanupExpiredJTIs(db: D1Database): Promise<void> {
  const now = Date.now();
  await db.prepare("DELETE FROM jwt_replay_cache WHERE expires_at < ?").bind(now).run();
}

