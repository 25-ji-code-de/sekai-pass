// SPDX-License-Identifier: Apache-2.0

import { mountHCaptcha } from './hcaptcha-helper.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Registration-only hCaptcha flow. It deliberately has no PoW fallback. */
export function createHCaptcha({ api, sitekey, widgetEl }) {
  let destroyed = false;
  let challengeId = null;
  let token = null;
  let widget = null;

  const init = (async () => {
    const challenge = await api.get('/challenge/init?provider=hcaptcha');
    if (destroyed) return;
    challengeId = challenge.challengeId;
    widget = await mountHCaptcha(widgetEl, {
      sitekey,
      onToken: (value) => { token = value; },
      onExpired: () => { token = null; },
      onError: () => { token = null; },
    });
  })();

  async function getProof(waitMs = 8000) {
    try {
      await init;
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (destroyed || !challengeId || !widget) return { ok: false, reason: 'failed' };

    const start = Date.now();
    while (Date.now() - start <= waitMs) {
      if (!token) token = widget.getToken();
      if (token) return { ok: true, type: 'hcaptcha', token, challengeId };
      await sleep(120);
    }
    return { ok: false, reason: 'interactive' };
  }

  async function refreshAfterFailure() {
    if (destroyed) return;
    token = null;
    challengeId = null;
    try {
      const challenge = await api.get('/challenge/init?provider=hcaptcha');
      if (destroyed) return;
      challengeId = challenge.challengeId;
      widget?.reset();
    } catch {
      /* The next submission reports a failed challenge. */
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    widget?.remove();
    widget = null;
  }

  return { getProof, refreshAfterFailure, destroy };
}
