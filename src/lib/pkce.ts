// PKCE (Proof Key for Code Exchange) utilities

/**
 * Verify PKCE code_verifier against code_challenge
 * OAuth 2.1: Only S256 method is supported
 */
export async function verifyPKCE(
  codeVerifier: string,
  codeChallenge: string,
  method: string = 'S256'
): Promise<boolean> {
  // OAuth 2.1: Only S256 method is allowed
  if (method !== 'S256') {
    return false;
  }

  // S256 method: SHA256(verifier) must equal challenge
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  const computedChallenge = base64URLEncode(hashArray);
  return computedChallenge === codeChallenge;
}

/**
 * Base64 URL encode (without padding)
 */
function base64URLEncode(buffer: number[] | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? Array.from(buffer) : buffer;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Validate code_challenge format
 * OAuth 2.1: Only S256 method is supported
 */
export function validateCodeChallenge(
  codeChallenge: string | null,
  method: string | null
): boolean {
  if (!codeChallenge) {
    return false;
  }

  // Check length (43-128 characters for S256)
  if (codeChallenge.length < 43 || codeChallenge.length > 128) {
    return false;
  }

  // Check format (base64url)
  if (!/^[A-Za-z0-9_-]+$/.test(codeChallenge)) {
    return false;
  }

  // OAuth 2.1: Only S256 method is allowed
  if (method && method !== 'S256') {
    return false;
  }

  return true;
}

/**
 * Validate code_verifier format
 */
export function validateCodeVerifier(codeVerifier: string | null): boolean {
  if (!codeVerifier) {
    return false;
  }

  // Must be 43-128 characters
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }

  // Must be base64url format
  if (!/^[A-Za-z0-9_-]+$/.test(codeVerifier)) {
    return false;
  }

  return true;
}
