/**
 * Verify Cloudflare Turnstile token
 * @param token The cf-turnstile-response token from the form
 * @param secretKey The Turnstile secret key
 * @param remoteIp Optional remote IP address
 * @returns Promise<boolean> True if verification succeeds
 */
export async function verifyTurnstile(
  token: string,
  secretKey: string,
  remoteIp?: string
): Promise<boolean> {
  if (!token || !secretKey) {
    return false;
  }

  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIp) {
      formData.append('remoteip', remoteIp);
    }

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

    return data.success;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}
