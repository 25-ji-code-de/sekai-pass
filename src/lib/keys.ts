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
  const expiresAt = now + 90 * 24 * 60 * 60 * 1000; // 90 days

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
    { expirationTtl: 90 * 24 * 60 * 60 } // 90 days
  );

  // Update current key pointer
  await kv.put(KV_CURRENT_KEY, key.kid);
}

/**
 * Get current signing key (KV cached)
 */
export async function getCurrentSigningKey(
  db: D1Database,
  kv: KVNamespace,
  encryptionKey: string
): Promise<SigningKey | null> {
  // Try to get current key ID from KV
  const currentKid = await kv.get(KV_CURRENT_KEY);

  if (currentKid) {
    // Try to get key from KV cache
    const cachedKey = await kv.get(`${KV_KEY_PREFIX}${currentKid}`);
    if (cachedKey) {
      const keyData = JSON.parse(cachedKey);
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
  }

  // Fallback to D1
  const result = await db.prepare(
    `SELECT * FROM signing_keys WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  ).first();

  if (!result) {
    // No signing key exists, generate one automatically
    const newKey = await generateSigningKey();
    await storeSigningKey(db, kv, newKey, encryptionKey);

    return {
      kid: newKey.kid,
      publicKeyJWK: newKey.publicKey,
      privateKeyJWK: newKey.privateKey,
      algorithm: "ES256",
      createdAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      revokedAt: null,
      status: "active"
    };
  }

  // Decrypt private key
  const privateKey = await decryptPrivateKey(
    result.private_key_jwk as string,
    encryptionKey
  );

  const signingKey: SigningKey = {
    kid: result.kid as string,
    publicKeyJWK: JSON.parse(result.public_key_jwk as string),
    privateKeyJWK: privateKey,
    algorithm: result.algorithm as string,
    createdAt: result.created_at as number,
    expiresAt: result.expires_at as number,
    revokedAt: result.revoked_at as number | null,
    status: result.status as "active" | "rotating" | "revoked"
  };

  // Update KV cache
  await kv.put(
    `${KV_KEY_PREFIX}${signingKey.kid}`,
    JSON.stringify({
      kid: signingKey.kid,
      publicKey: signingKey.publicKeyJWK,
      privateKey: signingKey.privateKeyJWK,
      algorithm: signingKey.algorithm,
      createdAt: signingKey.createdAt,
      expiresAt: signingKey.expiresAt
    }),
    { expirationTtl: 90 * 24 * 60 * 60 }
  );

  await kv.put(KV_CURRENT_KEY, signingKey.kid);

  return signingKey;
}

/**
 * Get public keys for JWKS endpoint
 */
export async function getPublicKeys(db: D1Database): Promise<JsonWebKey[]> {
  const now = Date.now();
  const gracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Get active keys and recently expired keys (grace period)
  const results = await db.prepare(
    `SELECT kid, public_key_jwk FROM signing_keys
     WHERE status != 'revoked' AND (expires_at > ? OR expires_at > ?)
     ORDER BY created_at DESC`
  ).bind(now, now - gracePeriod).all();

  return results.results.map((row: any) => JSON.parse(row.public_key_jwk));
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

  // Mark current active key as rotating
  await db.prepare(
    `UPDATE signing_keys SET status = 'rotating' WHERE status = 'active'`
  ).run();

  // Generate new key
  const newKey = await generateSigningKey();

  // Store new key
  await storeSigningKey(db, kv, newKey, encryptionKey);

  // After grace period (7 days), revoke old keys
  const gracePeriodEnd = now - 7 * 24 * 60 * 60 * 1000;
  await db.prepare(
    `UPDATE signing_keys SET status = 'revoked', revoked_at = ?
     WHERE status = 'rotating' AND created_at < ?`
  ).bind(now, gracePeriodEnd).run();
}

/**
 * Check if key rotation is needed and perform it
 */
export async function checkAndRotateKeys(
  db: D1Database,
  kv: KVNamespace,
  encryptionKey: string
): Promise<boolean> {
  const currentKey = await getCurrentSigningKey(db, kv, encryptionKey);

  if (!currentKey) {
    // No key exists, generate initial key
    const newKey = await generateSigningKey();
    await storeSigningKey(db, kv, newKey, encryptionKey);
    return true;
  }

  const now = Date.now();
  const rotationThreshold = 90 * 24 * 60 * 60 * 1000; // 90 days

  // Check if key is older than rotation threshold
  if (now - currentKey.createdAt >= rotationThreshold) {
    await rotateSigningKeys(db, kv, encryptionKey);
    return true;
  }

  return false;
}
