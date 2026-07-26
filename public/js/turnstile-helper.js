// SPDX-License-Identifier: Apache-2.0
/**
 * Explicit-mode Turnstile loader for SPAs.
 *
 * Do NOT call turnstile.ready() — CF warns it breaks if api.js is not fully loaded.
 * Use onload= injection, then render().
 *
 * 600* / challenge-platform 400 often means the challenge iframe failed (network,
 * bot score, region). Rebuilding the widget usually makes postMessage races worse;
 * prefer CF auto-retry, then fall back to PoW via onFatal.
 */

const SCRIPT_BASE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/**
 * Soft deadline: no token by then → treat as failed for callers that poll.
 * Generous on purpose: a cold first visit (uncached api.js, fresh challenge
 * state) routinely needs 10-20s. The countdown is cancelled entirely once the
 * widget turns interactive — a checkbox waiting on the user is not a failure.
 */
const SOFT_DEADLINE_MS = 30000;

/** @type {Promise<boolean> | null} */
let apiLoadPromise = null;

function ensureApi() {
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise((resolve) => {
    if (typeof window.turnstile?.render === 'function') {
      resolve(true);
      return;
    }

    const existing = document.querySelectorAll(
      'script[src*="challenges.cloudflare.com/turnstile"]'
    );

    const finish = (ok) => resolve(!!ok && typeof window.turnstile?.render === 'function');

    if (existing.length > 0 && typeof window.turnstile?.render !== 'function') {
      const started = Date.now();
      const poll = setInterval(() => {
        if (typeof window.turnstile?.render === 'function') {
          clearInterval(poll);
          finish(true);
        } else if (Date.now() - started > 12000) {
          clearInterval(poll);
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

function afterLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   sitekey: string,
 *   theme?: string,
 *   onToken?: (token: string) => void,
 *   onError?: (code: string, count: number) => void,
 *   onFatal?: (code: string) => void,
 * }} opts
 * @returns {Promise<null | {
 *   getToken: () => string | null,
 *   reset: () => void,
 *   remove: () => void,
 *   waitForToken: (timeoutMs?: number) => Promise<string | null>,
 *   hadFatalError: () => boolean,
 *   isInteractive: () => boolean,
 * }>}
 */
export async function mountTurnstile(container, opts) {
  if (!container || !opts?.sitekey) return null;

  const ok = await ensureApi();
  if (!ok) return null;

  await afterLayout();

  // Container must have layout box; zero-size hosts break the challenge iframe.
  if (container.offsetWidth < 10) {
    container.style.minWidth = '300px';
    container.style.minHeight = '65px';
  }

  let token = null;
  let widgetId = null;
  let destroyed = false;
  let fatal = false;
  let interactive = false;
  let errorCount = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let softTimer = null;

  const markFatal = (code) => {
    if (fatal || destroyed) return;
    fatal = true;
    if (softTimer != null) {
      clearTimeout(softTimer);
      softTimer = null;
    }
    try {
      opts.onFatal?.(String(code ?? 'unknown'));
    } catch {
      /* ignore */
    }
  };

  const clearContainer = () => {
    try {
      if (widgetId != null && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
    } catch {
      /* ignore */
    }
    widgetId = null;
    container.innerHTML = '';
  };

  const renderOnce = () => {
    if (destroyed || typeof window.turnstile?.render !== 'function') return;
    clearContainer();
    token = null;
    interactive = false;

    try {
      widgetId = window.turnstile.render(container, {
        sitekey: opts.sitekey,
        theme: opts.theme || 'dark',
        appearance: 'always',
        size: 'normal',
        // Let CF retry flaky challenges; our own destroy/rebuild worsens postMessage races.
        retry: 'auto',
        'retry-interval': 3000,
        'refresh-expired': 'auto',
        callback: (t) => {
          token = t || null;
          if (token) {
            if (softTimer != null) {
              clearTimeout(softTimer);
              softTimer = null;
            }
            try {
              opts.onToken?.(token);
            } catch {
              /* ignore */
            }
          }
        },
        'expired-callback': () => {
          token = null;
        },
        'timeout-callback': () => {
          token = null;
        },
        'before-interactive-callback': () => {
          // Widget needs user input (checkbox). It is healthy and waiting on a
          // human — a fixed deadline no longer applies.
          interactive = true;
          if (softTimer != null) {
            clearTimeout(softTimer);
            softTimer = null;
          }
        },
        'error-callback': (code) => {
          token = null;
          const codeStr = String(code ?? '');
          console.warn('[Turnstile] widget error', codeStr);
          errorCount += 1;
          try {
            opts.onError?.(codeStr, errorCount);
          } catch {
            /* ignore */
          }

          const family = codeStr.slice(0, 3);
          if (family === '110') {
            // Config error (bad sitekey / hostname) — retrying cannot fix it.
            markFatal(codeStr);
          } else if (family === '600' || family === '300') {
            // Generic challenge failure. Cold first connections commonly throw
            // one or two of these before retry:auto succeeds; only give up
            // after several consecutive failures.
            if (errorCount >= 4) {
              markFatal(codeStr);
            }
          }

          // truthy = we handled (suppress CF default console spam beyond our log)
          return true;
        },
      });
    } catch (err) {
      console.error('[Turnstile] render threw', err);
      markFatal('render');
    }
  };

  renderOnce();

  await new Promise((r) => setTimeout(r, 50));
  if (widgetId == null) {
    markFatal('no-widget');
    return null;
  }

  softTimer = setTimeout(() => {
    if (!token && !destroyed && !interactive) {
      console.warn('[Turnstile] soft deadline, no token');
      markFatal('timeout');
    }
  }, SOFT_DEADLINE_MS);

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
          setTimeout(tick, 100);
        };
        tick();
      });
    },
    reset() {
      token = null;
      fatal = false;
      interactive = false;
      errorCount = 0;
      if (softTimer != null) {
        clearTimeout(softTimer);
        softTimer = null;
      }
      softTimer = setTimeout(() => {
        if (!token && !destroyed && !interactive) markFatal('timeout');
      }, SOFT_DEADLINE_MS);

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
      if (softTimer != null) {
        clearTimeout(softTimer);
        softTimer = null;
      }
      clearContainer();
      token = null;
    },
    hadFatalError() {
      return fatal;
    },
    isInteractive() {
      return interactive && !token && !fatal;
    },
  };
}
