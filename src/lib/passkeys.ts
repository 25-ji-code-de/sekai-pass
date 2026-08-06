/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthenticatorTransportFuture,
  Base64URLString,
  WebAuthnCredential,
} from "@simplewebauthn/server";

export const PASSKEY_CHALLENGE_TTL = 5 * 60;
export const MAX_PASSKEY_NAME_LENGTH = 50;
export const MAX_PASSKEYS_PER_USER = 10;

export type PasskeyChallengeState = {
  challenge: string;
  rpID: string;
  origin: string;
  createdAt: number;
  userId?: string;
};

export type StoredPasskeyRow = {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
};

export function getPasskeyRP(requestUrl: string) {
  const url = new URL(requestUrl);
  return {
    rpID: url.hostname,
    origin: url.origin,
    rpName: "SEKAI Pass",
  };
}

export function normalizePasskeyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_PASSKEY_NAME_LENGTH) return null;
  return name;
}

export function bytesToBase64URL(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64URLToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeUserHandle(userId: string): string {
  return bytesToBase64URL(new TextEncoder().encode(userId));
}

export function serializeTransports(
  transports: AuthenticatorTransportFuture[] | undefined,
): string | null {
  return transports?.length ? JSON.stringify(transports) : null;
}

export function parseTransports(value: unknown): AuthenticatorTransportFuture[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return undefined;
    }
    return parsed as AuthenticatorTransportFuture[];
  } catch {
    return undefined;
  }
}

export function toWebAuthnCredential(row: StoredPasskeyRow): WebAuthnCredential {
  return {
    id: row.credential_id as Base64URLString,
    publicKey: base64URLToBytes(row.public_key),
    counter: Number(row.counter),
    transports: parseTransports(row.transports),
  };
}

export function parsePasskeyChallenge(
  raw: string | null,
  requireUserId: boolean,
): PasskeyChallengeState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as Record<string, unknown>;
    if (
      typeof state.challenge !== "string" ||
      typeof state.rpID !== "string" ||
      typeof state.origin !== "string" ||
      typeof state.createdAt !== "number" ||
      (requireUserId && typeof state.userId !== "string")
    ) {
      return null;
    }
    return {
      challenge: state.challenge,
      rpID: state.rpID,
      origin: state.origin,
      createdAt: state.createdAt,
      userId: typeof state.userId === "string" ? state.userId : undefined,
    };
  } catch {
    return null;
  }
}

export function isPasskeyChallengeFresh(state: PasskeyChallengeState): boolean {
  return Date.now() - state.createdAt <= PASSKEY_CHALLENGE_TTL * 1000;
}
