// SPDX-License-Identifier: Apache-2.0

const SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?render=explicit';
let loadPromise = null;

function loadApi() {
  if (typeof window.hcaptcha?.render === 'function') return Promise.resolve(true);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    const existing = document.querySelector('script[src*="js.hcaptcha.com/1/api.js"]');
    const finish = () => resolve(typeof window.hcaptcha?.render === 'function');
    if (existing) {
      const started = Date.now();
      const poll = setInterval(() => {
        if (typeof window.hcaptcha?.render === 'function') {
          clearInterval(poll);
          finish();
        } else if (Date.now() - started > 12000) {
          clearInterval(poll);
          finish();
        }
      }, 50);
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = finish;
    script.onerror = finish;
    document.head.appendChild(script);
    setTimeout(finish, 12000);
  });
  return loadPromise;
}

export async function mountHCaptcha(container, { sitekey, theme = 'dark', onToken, onExpired, onError }) {
  const loaded = await loadApi();
  if (!loaded || typeof window.hcaptcha?.render !== 'function') return null;

  let widgetId = null;
  try {
    widgetId = window.hcaptcha.render(container, {
      sitekey,
      theme,
      callback: onToken,
      'expired-callback': onExpired,
      'error-callback': onError,
    });
  } catch (error) {
    onError?.(error);
    return null;
  }

  return {
    getToken() {
      try {
        return window.hcaptcha.getResponse(widgetId) || null;
      } catch {
        return null;
      }
    },
    reset() {
      window.hcaptcha.reset(widgetId);
    },
    remove() {
      try {
        window.hcaptcha.reset(widgetId);
      } catch {
        /* ignore */
      }
      container.innerHTML = '';
    },
  };
}
