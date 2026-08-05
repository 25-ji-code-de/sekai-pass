/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { verifyTurnstileDetailed } from "./turnstile.ts";

export type CaptchaProviderName = "turnstile" | "hcaptcha";

export type CaptchaVerifyResult = {
  success: boolean;
  errorCodes?: string[];
  hostname?: string;
};

export interface CaptchaProvider {
  readonly name: CaptchaProviderName;
  readonly responseField: string;
  verify(token: string, secretKey: string, remoteIp?: string): Promise<CaptchaVerifyResult>;
}

const turnstileProvider: CaptchaProvider = {
  name: "turnstile",
  responseField: "cf-turnstile-response",
  verify: verifyTurnstileDetailed,
};

const hcaptchaProvider: CaptchaProvider = {
  name: "hcaptcha",
  responseField: "h-captcha-response",
  async verify(token, secretKey, remoteIp) {
    if (!token || !secretKey) {
      return { success: false, errorCodes: ["missing-input"] };
    }

    try {
      const formData = new URLSearchParams();
      formData.set("secret", secretKey);
      formData.set("response", token);
      if (remoteIp && remoteIp !== "unknown") formData.set("remoteip", remoteIp);

      const response = await fetch("https://api.hcaptcha.com/siteverify", {
        method: "POST",
        body: formData,
      });
      const data = await response.json() as {
        success: boolean;
        "error-codes"?: string[];
        hostname?: string;
      };

      if (!data.success) {
        console.error("hCaptcha siteverify failed:", data["error-codes"] || [], "hostname=", data.hostname);
      }
      return {
        success: data.success,
        errorCodes: data["error-codes"],
        hostname: data.hostname,
      };
    } catch (error) {
      console.error("hCaptcha verification error:", error);
      return { success: false, errorCodes: ["internal-error"] };
    }
  },
};

export function getCaptchaProvider(name: unknown): CaptchaProvider | null {
  if (name === "hcaptcha") return hcaptchaProvider;
  if (name === "turnstile" || name === undefined || name === null) return turnstileProvider;
  return null;
}
