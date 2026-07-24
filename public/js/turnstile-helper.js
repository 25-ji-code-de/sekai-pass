// SPDX-License-Identifier: Apache-2.0
/**
 * Explicit-mode Turnstile loader for SPAs.
 *
 * Do NOT call turnstile.ready() — CF warns that it breaks when invoked
 * before api.js has finished loading (common with async <script> tags).
 * Use the official onload= callback instead, then render().
 */

const SCRIPT_BASE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const MAX_REBUILD = 2;

/** @type {Promise<boolean> | null} */
let apiLoadPromise = null;

function ensureApi() {
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise((resolve) => {
    // Real API already present (full render implementation).
    if (typeof window.turnstile?.render === 'function') {
      resolve(true);
      return;
    }

    // Drop any preload tags that lack onload — they race our controlled load.
    // We still honor a fully-loaded API above; only inject if needed.
    const existing = document.querySelectorAll(
      'script[src*="challenges.cloudflare.com/turnstile"]'
    );

    const finish = (ok) => resolve(!!ok && typeof window.turnstile?.render === 'function');

    // If a previous tag is still loading, poll for the real API (no ready()).
    if (existing.length > 0 && typeof window.turnstile?.render !== 'function') {
      const started = Date.now();
      const poll = setInterval(() => {
        if (typeof window.turnstile?.render === 'function') {
          clearInterval(poll);
          finish(true);
        } else if (Date.now() - started > 12000) {
          clearInterval(poll);
          // Timed out on preload — inject a controlled onload script as fallback.
          injectWithOnload(finish);
        }
      }, 40);
      return;
    }

    injectWithOnload(finish);
  });

  return apiLoadPromise;
}

function injectWithOnload(finish) {
  const cbName = `__onTurnstileLoad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let settled = false;
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    try {
      delete window[cbName];
    } catch {
      /* ignore */
    }
    finish(ok);
  };

  window[cbName] = () => settle(true);

  const script = document.createElement('script');
  script.src = `${SCRIPT_BASE}&onload=${cbName}`;
  script.async = true;
  script.onerror = () => settle(false);
  document.head.appendChild(script);
  setTimeout(() => settle(typeof window.turnstile?.render === 'function'), 12000);
}

/** Wait two frames so the container is laid out before iframe attach. */
function afterLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
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
 *   hadFatalError: () => boolean,
 * }>}
 */
export async function mountTurnstile(container, opts) {
  if (!container || !opts?.sitekey) return null;

  const ok = await ensureApi();
  if (!ok) return null;

  await afterLayout();

  let token = null;
  let widgetId = null;
  let rebuilds = 0;
  let destroyed = false;
  let fatal = false;

  const clearContainer = () => {
    try {
      if (widgetId != null && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
    } catch {
      /* ignore */
    }
    widgetId = null;
    // Remove leftover iframes Turnstile may leave behind
    container.innerHTML = '';
  };

  const renderOnce = () => {
    if (destroyed || typeof window.turnstile?.render !== 'function') return;
    clearContainer();
    token = null;

    try {
      widgetId = window.turnstile.render(container, {
        sitekey: opts.sitekey,
        theme: opts.theme || 'dark',
        appearance: 'always',
        // We rebuild the whole widget on 600*; CF's own auto-retry can race the iframe.
        retry: 'never',
        'refresh-expired': 'auto',
        callback: (t) => {
          token = t || null;
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

          // 600* often = first challenge failure. Rebuild a couple times, then mark fatal
          // so the page can fall back to PoW instead of trapping the user.
          if (!destroyed && rebuilds < MAX_REBUILD) {
            rebuilds += 1;
            setTimeout(() => {
              if (!destroyed) renderOnce();
            }, 800 * rebuilds);
          } else {
            fatal = true;
          }
          return true;
        },
      });
    } catch (err) {
      console.error('[Turnstile] render threw', err);
      fatal = true;
    }
  };

  renderOnce();

  // If first paint still produces no iframe / no progress, treat as failed mount.
  await new Promise((r) => setTimeout(r, 50));
  if (widgetId == null) {
    fatal = true;
    return null;
  }

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
          if (fatal) return resolve(null);
          const t = this.getToken();
          if (t) return resolve(t);
          if (destroyed || Date.now() - start > timeoutMs) return resolve(null);
          setTimeout(tick, 120);
        };
        tick();
      });
    },
    reset() {
      token = null;
      fatal = false;
      rebuilds = 0;
      if (widgetId != null && window.turnstile?.reset) {
        try {
          window.turnstile.reset(widgetId);
          return;
        } catch {
          /* rebuild */
        }
      }
      renderOnce();
    },
    remove() {
      destroyed = true;
      clearContainer();
      token = null;
    },
    hadFatalError() {
      return fatal;
    },
  };
}
