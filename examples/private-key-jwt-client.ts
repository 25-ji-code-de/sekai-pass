/**
 * Private Key JWT Client Example
 *
 * This example demonstrates how to authenticate with SEKAI Pass
 * using Private Key JWT (RFC 7523) client authentication.
 *
 * Supports both ES256 and RS256 algorithms.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// ============================================
// Key Generation
// ============================================

/**
 * Generate ES256 (ECDSA P-256) key pair
 * Recommended for most use cases
 */
export function generateES256KeyPair(): {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256
    publicKeyEncoding: { type: 'spki', format: 'jwk' },
    privateKeyEncoding: { type: 'pkcs8', format: 'jwk' }
  });

  return { publicKey, privateKey };
}

/**
 * Generate RS256 (RSA 2048-bit) key pair
 * Alternative to ES256, larger key size
 */
export function generateRS256KeyPair(): {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'jwk' },
    privateKeyEncoding: { type: 'pkcs8', format: 'jwk' }
  });

  return { publicKey, privateKey };
}

// ============================================
// JWT Creation
// ============================================

/**
 * Base64URL encode
 */
function base64url(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Create JWT assertion for client authentication
 *
 * @param clientId - OAuth client ID
 * @param tokenEndpoint - Full URL of token endpoint
 * @param privateKeyJWK - Private key in JWK format
 * @param kid - Key ID (must match registered public key)
 * @param algorithm - 'ES256' or 'RS256'
 * @returns JWT assertion string
 */
export function createJWTAssertion(
  clientId: string,
  tokenEndpoint: string,
  privateKeyJWK: JsonWebKey,
  kid: string,
  algorithm: 'ES256' | 'RS256' = 'ES256'
): string {
  const now = Math.floor(Date.now() / 1000);

  // JWT Header
  const header = {
    alg: algorithm,
    typ: 'JWT',
    kid: kid
  };

  // JWT Payload (RFC 7523 required claims)
  const payload = {
    iss: clientId,        // Issuer = client_id
    sub: clientId,        // Subject = client_id
    aud: tokenEndpoint,   // Audience = token endpoint URL
    exp: now + 300,       // Expiration = 5 minutes from now
    iat: now,             // Issued at = now
    jti: uuidv4()         // JWT ID = unique identifier
  };

  // Encode header and payload
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Import private key
  const privateKey = crypto.createPrivateKey({
    key: privateKeyJWK,
    format: 'jwk'
  });

  // Sign based on algorithm
  let signature: Buffer;

  if (algorithm === 'ES256') {
    // ECDSA signature (IEEE P1363 format)
    signature = crypto.sign(
      null,
      Buffer.from(signingInput),
      {
        key: privateKey,
        dsaEncoding: 'ieee-p1363' // Important for ES256
      }
    );
  } else if (algorithm === 'RS256') {
    // RSA signature
    signature = crypto.sign(
      'sha256',
      Buffer.from(signingInput),
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING
      }
    );
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  // Encode signature
  const encodedSignature = base64url(signature);

  return `${signingInput}.${encodedSignature}`;
}

// ============================================
// OAuth Token Exchange
// ============================================

/**
 * Exchange authorization code for access token
 * Uses Private Key JWT for client authentication
 */
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  tokenEndpoint: string,
  privateKeyJWK: JsonWebKey,
  kid: string,
  redirectUri: string,
  algorithm: 'ES256' | 'RS256' = 'ES256',
  codeVerifier?: string // Optional PKCE code verifier
): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  id_token?: string;
}> {
  // Create JWT assertion
  const assertion = createJWTAssertion(
    clientId,
    tokenEndpoint,
    privateKeyJWK,
    kid,
    algorithm
  );

  // Build request body
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    redirect_uri: redirectUri
  });

  // Add PKCE code verifier if provided
  if (codeVerifier) {
    body.append('code_verifier', codeVerifier);
  }

  // Make token request
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token request failed: ${error.error} - ${error.error_description || ''}`
    );
  }

  return await response.json();
}

/**
 * Refresh access token using refresh token
 * Uses Private Key JWT for client authentication
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  tokenEndpoint: string,
  privateKeyJWK: JsonWebKey,
  kid: string,
  algorithm: 'ES256' | 'RS256' = 'ES256'
): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  // Create JWT assertion
  const assertion = createJWTAssertion(
    clientId,
    tokenEndpoint,
    privateKeyJWK,
    kid,
    algorithm
  );

  // Build request body
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion
  });

  // Make token request
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token refresh failed: ${error.error} - ${error.error_description || ''}`
    );
  }

  return await response.json();
}

// ============================================
// Example Usage
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('Private Key JWT Client Example');
  console.log('='.repeat(60));
  console.log();

  // Step 1: Generate key pair (one-time setup)
  console.log('Step 1: Generating ES256 key pair...');
  const { publicKey, privateKey } = generateES256KeyPair();

  console.log('\nPublic Key (JWK) - Register this with SEKAI Pass:');
  console.log(JSON.stringify(publicKey, null, 2));

  console.log('\nPrivate Key (JWK) - Keep this secret:');
  console.log(JSON.stringify(privateKey, null, 2));
  console.log();

  // Step 2: Register public key in database
  console.log('Step 2: Register public key in database:');
  console.log(`
INSERT INTO client_keys (
    id,
    client_id,
    key_id,
    public_key_jwk,
    algorithm,
    created_at,
    status
) VALUES (
    '${uuidv4()}',
    'your-client-id',
    'key-2024-01',
    '${JSON.stringify(publicKey)}',
    'ES256',
    ${Date.now()},
    'active'
);

UPDATE applications
SET token_endpoint_auth_method = 'private_key_jwt'
WHERE client_id = 'your-client-id';
  `);
  console.log();

  // Step 3: Create JWT assertion
  console.log('Step 3: Creating JWT assertion...');
  const clientId = 'your-client-id';
  const tokenEndpoint = 'https://auth.example.com/oauth/token';
  const kid = 'key-2024-01';

  const assertion = createJWTAssertion(
    clientId,
    tokenEndpoint,
    privateKey,
    kid,
    'ES256'
  );

  console.log('\nJWT Assertion:');
  console.log(assertion);
  console.log();

  // Decode JWT to show structure
  const [headerB64, payloadB64, signatureB64] = assertion.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

  console.log('JWT Header:');
  console.log(JSON.stringify(header, null, 2));
  console.log();

  console.log('JWT Payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log();

  // Step 4: Exchange authorization code for tokens
  console.log('Step 4: Exchange authorization code for tokens');
  console.log(`
// After user authorizes and you receive the authorization code:
const tokens = await exchangeCodeForTokens(
  'authorization_code_here',
  '${clientId}',
  '${tokenEndpoint}',
  privateKey,
  '${kid}',
  'https://yourapp.com/callback',
  'ES256'
);

console.log('Access Token:', tokens.access_token);
console.log('Refresh Token:', tokens.refresh_token);
console.log('Expires In:', tokens.expires_in, 'seconds');
  `);
  console.log();

  // Step 5: Refresh access token
  console.log('Step 5: Refresh access token when expired');
  console.log(`
const newTokens = await refreshAccessToken(
  tokens.refresh_token,
  '${clientId}',
  '${tokenEndpoint}',
  privateKey,
  '${kid}',
  'ES256'
);

console.log('New Access Token:', newTokens.access_token);
  `);
  console.log();

  console.log('='.repeat(60));
  console.log('Example complete!');
  console.log('='.repeat(60));
}

// Run example if executed directly
if (require.main === module) {
  main().catch(console.error);
}

// ============================================
// RS256 Example
// ============================================

/**
 * Example using RS256 instead of ES256
 */
export async function rs256Example() {
  console.log('RS256 Example');
  console.log('='.repeat(60));

  // Generate RS256 key pair
  const { publicKey, privateKey } = generateRS256KeyPair();

  console.log('Public Key (RS256):');
  console.log(JSON.stringify(publicKey, null, 2));
  console.log();

  // Create JWT assertion with RS256
  const assertion = createJWTAssertion(
    'your-client-id',
    'https://auth.example.com/oauth/token',
    privateKey,
    'key-rs256-2024',
    'RS256' // Use RS256 algorithm
  );

  console.log('JWT Assertion (RS256):');
  console.log(assertion);
  console.log();

  // Exchange code for tokens (same API, different algorithm)
  // const tokens = await exchangeCodeForTokens(
  //   'code',
  //   'your-client-id',
  //   'https://auth.example.com/oauth/token',
  //   privateKey,
  //   'key-rs256-2024',
  //   'https://yourapp.com/callback',
  //   'RS256' // Specify RS256
  // );
}
