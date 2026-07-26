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


export type TurnstileVerifyResult = {
  success: boolean;
  errorCodes?: string[];
};

/**
 * Verify Cloudflare Turnstile token via siteverify.
 *
 * Intentionally does NOT send `remoteip`: dual-stack (IPv4 vs IPv6) and
 * multi-value X-Forwarded-For mismatches are a common cause of
 * "first attempt fails, refresh works" for otherwise-valid tokens.
 */
export async function verifyTurnstileDetailed(
  token: string,
  secretKey: string
): Promise<TurnstileVerifyResult> {
  if (!token || !secretKey) {
    return { success: false, errorCodes: ['missing-input'] };
  }

  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json() as {
      success: boolean;
      'error-codes'?: string[];
      challenge_ts?: string;
      hostname?: string;
    };

    if (!data.success) {
      console.error('Turnstile siteverify failed:', data['error-codes'] || [], 'hostname=', data.hostname);
    }

    return { success: data.success, errorCodes: data['error-codes'] };
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return { success: false, errorCodes: ['internal-error'] };
  }
}
