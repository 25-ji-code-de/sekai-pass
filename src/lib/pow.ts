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


/**
 * Stateful Proof-of-Work challenge system
 * Server controls when PoW is allowed via KV-stored challenge state
 */

/** Baseline difficulty: ~1M hashes, ~1-2s with sync SHA-256 in a Web Worker. */
export const POW_DIFFICULTY = 20;
/**
 * Difficulty for regions where PoW is only a distress fallback (Turnstile is
 * expected to work there): 4x the work, so the cheap path for bots stays shut.
 */
export const POW_DIFFICULTY_STRICT = 22;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hasLeadingZeroBits(hexHash: string, bits: number): boolean {
  const fullNibbles = Math.floor(bits / 4);
  const remainBits = bits % 4;

  for (let i = 0; i < fullNibbles; i++) {
    if (hexHash[i] !== '0') return false;
  }

  if (remainBits > 0) {
    const nibble = parseInt(hexHash[fullNibbles], 16);
    if (nibble >= (1 << (4 - remainBits))) return false;
  }

  return true;
}

export interface ChallengeState {
  ip: string;
  /** Provider selected when the challenge was issued; old states default to Turnstile. */
  captchaProvider?: "turnstile" | "hcaptcha";
  issued: number;
  turnstileAttempted: boolean;
  powIssued: boolean;
  powChallenge: string | null;
  /** Absent on states written before difficulty tiers existed → baseline. */
  powDifficulty?: number;
  used: boolean;
}

export function createChallengeState(ip: string): ChallengeState {
  return {
    ip,
    issued: Date.now(),
    turnstileAttempted: false,
    powIssued: false,
    powChallenge: null,
    used: false,
  };
}

export function generatePoWChallenge(
  difficulty: number = POW_DIFFICULTY
): { challenge: string; difficulty: number } {
  return { challenge: randomHex(16), difficulty };
}

export async function verifyPoWHash(
  challenge: string,
  nonce: string,
  difficulty: number = POW_DIFFICULTY
): Promise<boolean> {
  const hash = await sha256Hex(challenge + nonce);
  return hasLeadingZeroBits(hash, difficulty);
}
