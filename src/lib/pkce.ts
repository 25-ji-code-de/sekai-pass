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

  // S256 method: BASE64URL(SHA256(verifier)) must equal challenge
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const computedChallenge = base64URLEncode(new Uint8Array(hash));

  // Constant-time-ish compare (length first; equal length then XOR)
  if (computedChallenge.length !== codeChallenge.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < computedChallenge.length; i++) {
    diff |= computedChallenge.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Base64 URL encode (without padding). Chunked to avoid call-stack limits.
 */
function base64URLEncode(buffer: number[] | Uint8Array): string {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary)
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

  // Must be unreserved characters (RFC 7636) — base64url alphabet is a safe subset
  if (!/^[A-Za-z0-9._~-]+$/.test(codeVerifier)) {
    return false;
  }

  return true;
}
