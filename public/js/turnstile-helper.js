// SPDX-License-Identifier: Apache-2.0
/**
 * Reliable Turnstile explicit-render helper for SPAs.
 *
 * Root cause of "first attempt fails, refresh works":
 * - `window.turnstile` can exist before the iframe bridge is ready; calling
 *   render() then yields postMessage origin mismatches and client error 600010.
 * - Always wait for turnstile.ready(), and auto-rebuild the widget on 600* errors.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const MAX_REBUILD = 2;

function loadScript() {
  return new Promise((resolve) => {
    if (window.turnstile?.render) {
      resolve(true);
      return;
    }

    const existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
    if (existing) {
      // Script tag present (e.g. index.html preload) but API not ready yet.
      const started = Date.now();
      const poll = setInterval(() => {
        if (window.turnstile?.render) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started > 10000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 40);
      return;
    }

    const callbackName = `__onTurnstileLoad_${Date.now()}`;
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      try {
        delete window[callbackName];
      } catch {
        /* ignore */
      }
      resolve(ok);
    };

    window[callbackName] = () => settle(true);
    const script = document.createElement('script');
    script.src = `${SCRIPT_SRC}&onload=${callbackName}`;
    script.async = true;
    script.onerror = () => settle(false);
    document.head.appendChild(script);
    setTimeout(() => settle(!!window.turnstile?.render), 10000);
  });
}

function whenReady() {
  return new Promise((resolve) => {
    if (!window.turnstile) {
      resolve(false);
      return;
    }
    // ready() fires immediately if the API is already fully initialized.
    try {
      window.turnstile.ready(() => resolve(true));
      // Safety net if ready never fires (older/broken builds).
      setTimeout(() => resolve(!!window.turnstile?.render), 8000);
    } catch {
      resolve(!!window.turnstile?.render);
    }
  });
}

/**
 * @param {HTMLElement} container
 * @param {{ sitekey: string, theme?: string }} opts
 * @returns {Promise<null | {
 *   getToken: () => string | null,
 *   reset: () => void,
 *   remove: () => void,
 *   waitForToken: (timeoutMs?: number) => Promise<string | null>,
 * }>}
 */
export async function mountTurnstile(container, opts) {
  if (!container || !opts?.sitekey) return null;

  const loaded = await loadScript();
  if (!loaded) return null;

  const ready = await whenReady();
  if (!ready) return null;

  let token = null;
  let widgetId = null;
  let rebuilds = 0;
  let destroyed = false;

  const clearContainer = () => {
    try {
      if (widgetId != null && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    } catch {
      /* ignore */
    }
    widgetId = null;
    container.innerHTML = '';
  };

  const renderOnce = () => {
    if (destroyed) return;
    clearContainer();
    token = null;

    widgetId = window.turnstile.render(container, {
      sitekey: opts.sitekey,
      theme: opts.theme || 'dark',
      retry: 'auto',
      'retry-interval': 4000,
      callback: (t) => {
        token = t;
      },
      'expired-callback': () => {
        token = null;
      },
      'timeout-callback': () => {
        token = null;
      },
      'error-callback': (code) => {
        token = null;
        const codeStr = String(code ?? '');
        console.warn('[Turnstile] widget error', codeStr);

        // 600* = generic challenge failure (often first-paint / iframe race).
        // Rebuild once or twice instead of forcing a full page refresh.
        if (rebuilds < MAX_REBUILD && !destroyed) {
          rebuilds += 1;
          setTimeout(() => {
            if (!destroyed) renderOnce();
          }, 400 + rebuilds * 300);
        }

        // truthy => we handled it (suppresses uncaught console noise)
        return true;
      },
    });
  };

  renderOnce();

  return {
    getToken() {
      if (token) return token;
      if (widgetId != null && window.turnstile?.getResponse) {
        try {
          const t = window.turnstile.getResponse(widgetId);
          if (t) token = t;
        } catch {
          /* ignore */
        }
      }
      if (!token) {
        const hidden = container.querySelector('input[name="cf-turnstile-response"]');
        if (hidden?.value) token = hidden.value;
      }
      return token;
    },
    waitForToken(timeoutMs = 15000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          const t = this.getToken();
          if (t) return resolve(t);
          if (destroyed || Date.now() - start > timeoutMs) return resolve(null);
          setTimeout(tick, 100);
        };
        tick();
      });
    },
    reset() {
      token = null;
      if (widgetId != null && window.turnstile) {
        try {
          window.turnstile.reset(widgetId);
          return;
        } catch {
          /* fall through to rebuild */
        }
      }
      rebuilds = 0;
      renderOnce();
    },
    remove() {
      destroyed = true;
      clearContainer();
      token = null;
    },
  };
}
