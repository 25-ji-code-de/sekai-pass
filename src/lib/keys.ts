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


// Signing Key Management for OIDC
// Handles ES256 key generation, storage, rotation, and retrieval

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { generateId } from "./password.ts";

export interface SigningKey {
  kid: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  algorithm: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  status: "active" | "rotating" | "revoked";
}

const KV_KEY_PREFIX = "signing_key:";
const KV_CURRENT_KEY = "current_signing_key";
const KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const VERIFICATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Generate ES256 key pair
 */
export async function generateSigningKey(): Promise<{
  kid: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}> {
  // Generate ECDSA P-256 key pair
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256"
    },
    true,
    ["sign", "verify"]
  );

  // Export keys as JWK
  const kp = keyPair as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("jwk", kp.publicKey) as JsonWebKey;
  const privateKey = await crypto.subtle.exportKey("jwk", kp.privateKey) as JsonWebKey;

  // Generate key ID
  const kid = generateId(16);

  // Add required JWK fields
  (publicKey as any).kid = kid;
  (publicKey as any).alg = "ES256";
  (publicKey as any).use = "sig";

  (privateKey as any).kid = kid;
  (privateKey as any).alg = "ES256";
  (privateKey as any).use = "sig";

  return {
    kid,
    publicKey,
    privateKey
  };
}

/**
 * Encrypt private key using AES-256-GCM
 */
async function encryptPrivateKey(
  privateKeyJWK: JsonWebKey,
  encryptionKey: string
): Promise<string> {
  // Derive encryption key from secret
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(encryptionKey),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // Encrypt private key
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(privateKeyJWK));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    aesKey,
    plaintext
  );

  // Combine salt + iv + ciphertext
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

  // Base64 encode (chunked — avoid spread argument limits)
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < combined.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      combined.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

/**
 * Decrypt private key
 */
async function decryptPrivateKey(
  encryptedData: string,
  encryptionKey: string
): Promise<JsonWebKey> {
  // Base64 decode
  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0));

  // Extract salt, iv, ciphertext
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const ciphertext = combined.slice(28);

  // Derive decryption key
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(encryptionKey),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // Decrypt
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    aesKey,
    ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * Store signing key in D1 and KV
 */
export async function storeSigningKey(
  db: D1Database,
  kv: KVNamespace,
  key: { kid: string; publicKey: JsonWebKey; privateKey: JsonWebKey },
  encryptionKey: string
): Promise<void> {
  const now = Date.now();
  const expiresAt = now + KEY_LIFETIME_MS;

  // Encrypt private key
  const encryptedPrivateKey = await encryptPrivateKey(key.privateKey, encryptionKey);

  // Store in D1
  await db.prepare(
    `INSERT INTO signing_keys (kid, public_key_jwk, private_key_jwk, algorithm, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    key.kid,
    JSON.stringify(key.publicKey),
    encryptedPrivateKey,
    "ES256",
    now,
    expiresAt,
    "active"
  ).run();

  // Cache in KV
  await kv.put(
    `${KV_KEY_PREFIX}${key.kid}`,
    JSON.stringify({
      kid: key.kid,
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      algorithm: "ES256",
      createdAt: now,
      expiresAt: expiresAt
    }),
    { expirationTtl: KEY_LIFETIME_MS / 1000 }
  );

  // Update current key pointer
  await kv.put(KV_CURRENT_KEY, key.kid);
}

/**
 * Convert a D1 signing-key row into the shape used by the signer.
 */
async function signingKeyFromRow(
  row: Record<string, unknown>,
  encryptionKey: string
): Promise<SigningKey> {
  return {
    kid: row.kid as string,
    publicKeyJWK: JSON.parse(row.public_key_jwk as string),
    privateKeyJWK: await decryptPrivateKey(row.private_key_jwk as string, encryptionKey),
    algorithm: row.algorithm as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    revokedAt: row.revoked_at as number | null,
    status: row.status as SigningKey["status"]
  };
}

async function cacheSigningKey(kv: KVNamespace, key: SigningKey): Promise<void> {
  const remainingSeconds = Math.max(60, Math.ceil((key.expiresAt - Date.now()) / 1000));

  await kv.put(
    `${KV_KEY_PREFIX}${key.kid}`,
    JSON.stringify({
      kid: key.kid,
      publicKey: key.publicKeyJWK,
      privateKey: key.privateKeyJWK,
      algorithm: key.algorithm,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt
    }),
    { expirationTtl: remainingSeconds }
  );
  await kv.put(KV_CURRENT_KEY, key.kid);
}

/**
 * Get an unexpired key for new signatures. If scheduled rotation has stopped,
 * this request-path guard rotates instead of signing with a key absent from
 * JWKS.
 */
export async function getCurrentSigningKey(
  db: D1Database,
  kv: KVNamespace,
  encryptionKey: string
): Promise<SigningKey> {
  const now = Date.now();
  const currentKid = await kv.get(KV_CURRENT_KEY);

  if (currentKid) {
    const cachedKey = await kv.get(`${KV_KEY_PREFIX}${currentKid}`);
    if (cachedKey) {
      const keyData = JSON.parse(cachedKey);
      if (keyData.expiresAt > now) {
        return {
          kid: keyData.kid,
          publicKeyJWK: keyData.publicKey,
          privateKeyJWK: keyData.privateKey,
          algorithm: keyData.algorithm,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          revokedAt: null,
          status: "active"
        };
      }

      // The pointer has no TTL of its own. Remove it so an expired cache entry
      // cannot remain the preferred signing key indefinitely.
      await kv.delete(KV_CURRENT_KEY);
      await kv.delete(`${KV_KEY_PREFIX}${currentKid}`);
    }
  }

  const loadUsableKey = () => db.prepare(
    `SELECT * FROM signing_keys
     WHERE status = 'active' AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(now).first();

  let result = await loadUsableKey();

  if (!result) {
    // This also handles an empty database. Marking expired active keys as
    // rotating preserves them in JWKS for verification grace while the newly
    // generated active key is used for all new signatures.
    await rotateSigningKeys(db, kv, encryptionKey);
    result = await loadUsableKey();
  }

  if (!result) {
    throw new Error("Failed to create an active signing key");
  }

  const signingKey = await signingKeyFromRow(result, encryptionKey);
  await cacheSigningKey(kv, signingKey);
  return signingKey;
}

/**
 * Get public keys for JWKS endpoint
 */
export async function getPublicKeys(db: D1Database): Promise<JsonWebKey[]> {
  const now = Date.now();

  // Keep recently expired keys published so already-issued ID tokens remain
  // verifiable during the grace period. New tokens never use these keys.
  const results = await db.prepare(
    `SELECT kid, public_key_jwk FROM signing_keys
     WHERE status != 'revoked' AND expires_at > ?
     ORDER BY created_at DESC`
  ).bind(now - VERIFICATION_GRACE_MS).all();

  return results.results.map((row: any) => JSON.parse(row.public_key_jwk));
}

/**
 * Return a non-empty JWKS even on a cold database or after scheduled rotation
 * has stopped past the verification grace period. This is deliberately only a
 * fallback: ordinary JWKS reads do not decrypt or generate private keys.
 */
export async function getOrCreatePublicKeys(
  db: D1Database,
  kv: KVNamespace,
  encryptionKey: string
): Promise<JsonWebKey[]> {
  const publicKeys = await getPublicKeys(db);
  if (publicKeys.length > 0) {
    return publicKeys;
  }

  await getCurrentSigningKey(db, kv, encryptionKey);
  return getPublicKeys(db);
}

/**
 * Get signing key by kid (for verification)
 */
export async function getSigningKeyByKid(
  db: D1Database,
  kid: string
): Promise<JsonWebKey | null> {
  const result = await db.prepare(
    `SELECT public_key_jwk FROM signing_keys WHERE kid = ?`
  ).bind(kid).first();

  if (!result) {
    return null;
  }

  return JSON.parse(result.public_key_jwk as string);
}

/**
 * Rotate signing keys
 */
export async function rotateSigningKeys(
  db: D1Database,
  kv: KVNamespace,
  encryptionKey: string
): Promise<void> {
  const now = Date.now();

  // Stop using every current active key for new signatures. expires_at is the
  // last moment a key may sign, so pinning it to the rotation time starts the
  // verification grace window now — whether we rotate early (proactive) or late
  // (a key that already outlived its lifetime). Late rotation still keeps the
  // old key published for the full grace, covering any token the request-path
  // guard signed just before it noticed the expiry.
  await db.prepare(
    `UPDATE signing_keys SET status = 'rotating', expires_at = ? WHERE status = 'active'`
  ).bind(now).run();

  // Generate new key
  const newKey = await generateSigningKey();

  // Store new key
  await storeSigningKey(db, kv, newKey, encryptionKey);

  // Keep old keys available until seven days after their signing lifetime ends.
  // The previous created_at predicate revoked a 90-day-old key immediately at
  // rotation time, despite JWKS promising a seven-day verification grace.
  await db.prepare(
    `UPDATE signing_keys SET status = 'revoked', revoked_at = ?
     WHERE status = 'rotating' AND expires_at <= ?`
  ).bind(now, now - VERIFICATION_GRACE_MS).run();
}

/**
 * Check if key rotation is needed and perform it
 */
export async function checkAndRotateKeys(
  db: D1Database,
  kv: KVNamespace,
  encryptionKey: string
): Promise<boolean> {
  const now = Date.now();
  const currentKey = await db.prepare(
    `SELECT created_at, expires_at FROM signing_keys
     WHERE status = 'active'
     ORDER BY created_at DESC LIMIT 1`
  ).first();

  // Rotation policy must read D1 directly. getCurrentSigningKey is a
  // request-path safety net that can create a fresh key, which would hide the
  // expired/missing state this scheduled check is responsible for detecting.
  // Rotate before expiry so the new key is published before it is needed.
  // Request-path expiry checks remain the safety net if scheduled execution
  // stops entirely.
  if (
    !currentKey ||
    (currentKey.expires_at as number) <= now + ROTATION_WINDOW_MS ||
    now - (currentKey.created_at as number) >= KEY_LIFETIME_MS - ROTATION_WINDOW_MS
  ) {
    await rotateSigningKeys(db, kv, encryptionKey);
    return true;
  }

  // Retire old verification-only keys even when the active key is still young.
  await db.prepare(
    `UPDATE signing_keys SET status = 'revoked', revoked_at = ?
     WHERE status = 'rotating' AND expires_at <= ?`
  ).bind(now, now - VERIFICATION_GRACE_MS).run();

  return false;
}
