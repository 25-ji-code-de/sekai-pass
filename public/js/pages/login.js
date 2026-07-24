// SPDX-License-Identifier: Apache-2.0
import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';
import { solvePoW } from '../pow-solver.js';

export function renderLogin(app, api, navigate) {
  const turnstileSiteKey = window.TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

  let captchaMode = 'pending';
  let challengeId = null;
  let powNonce = null;
  let turnstileToken = null;
  let turnstileWidgetId = null;

  app.innerHTML = `
    <div class="container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>
      <div id="error-message" class="error" style="display: none;"></div>
      <form id="login-form">
        <div class="form-group">
          <label for="username">用户名</label>
          <input type="text" id="username" name="username" required placeholder="请输入用户名" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" required placeholder="请输入密码" autocomplete="current-password">
        </div>
        <div class="form-group captcha-container">
          <div id="turnstile-widget"></div>
          <div id="pow-status" class="pow-status" style="display: none;"></div>
        </div>
        <button type="submit" id="login-btn">登录</button>
      </form>
      <div class="link">
        <p>还没有账号？ <a href="/register" data-link>立即注册</a></p>
      </div>
    </div>
    <footer class="site-footer">
      <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a> |
      <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
    </footer>
  `;

  const turnstileWidget = document.getElementById('turnstile-widget');
  const powStatus = document.getElementById('pow-status');

  // Fetch challenge ID in parallel
  let challengeReady = refreshChallenge();

  // Sequential captcha init: try Turnstile first, fall back to PoW
  initCaptcha();

  function refreshChallenge() {
    challengeId = null;
    return api.get('/challenge/init').then(r => {
      challengeId = r.challengeId;
      return challengeId;
    }).catch(err => {
      console.error('Challenge init failed:', err);
      return null;
    });
  }

  async function initCaptcha() {
    captchaMode = 'pending';
    turnstileToken = null;
    powNonce = null;

    try {
      // Wait up to 8s for Turnstile script (cold cache can be slow)
      const available = await waitForTurnstile(8000);

      if (available) {
        try {
          // Clear previous widget if re-init
          turnstileWidget.innerHTML = '';
          turnstileWidget.style.display = '';
          powStatus.style.display = 'none';

          turnstileWidgetId = window.turnstile.render(turnstileWidget, {
            sitekey: turnstileSiteKey,
            theme: 'dark',
            // Explicit callbacks: only treat captcha as ready after token arrives
            callback: (token) => {
              turnstileToken = token;
            },
            'expired-callback': () => {
              turnstileToken = null;
            },
            'error-callback': () => {
              turnstileToken = null;
            },
          });

          await challengeReady;
          if (!challengeId) throw new Error('no challengeId');
          await api.post('/challenge/report', { challengeId, turnstileLoaded: true });
          captchaMode = 'turnstile';
          return;
        } catch (e) {
          console.error('Turnstile render failed:', e);
        }
      }

      // Turnstile unavailable or render failed → PoW
      turnstileWidget.style.display = 'none';
      powStatus.style.display = 'flex';
      powStatus.innerHTML = '<div class="pow-spinner"></div><span>验证环境安全...</span>';
      powStatus.className = 'pow-status';

      await challengeReady;
      if (!challengeId) {
        powStatus.innerHTML = '<span class="pow-icon">✕</span><span>验证初始化失败，请刷新重试</span>';
        powStatus.className = 'pow-status error';
        return;
      }

      const result = await api.post('/challenge/report', { challengeId, turnstileLoaded: false });
      powNonce = await solvePoW(result.challenge, result.difficulty);
      captchaMode = 'pow';
      powStatus.innerHTML = '<span class="pow-icon">✓</span><span>环境验证通过</span>';
      powStatus.className = 'pow-status success';
    } catch (err) {
      console.error('Captcha init failed:', err);
      powStatus.style.display = 'flex';
      powStatus.innerHTML = '<span class="pow-icon">✕</span><span>验证失败，请刷新重试</span>';
      powStatus.className = 'pow-status error';
    }
  }

  function waitForTurnstile(timeout) {
    return new Promise(resolve => {
      if (window.turnstile) return resolve(true);

      // Load script if not present
      if (!document.querySelector('script[src*="turnstile"]')) {
        const callbackName = 'onTurnstileLoad_' + Date.now();
        let settled = false;
        const settle = (ok) => {
          if (settled) return;
          settled = true;
          delete window[callbackName];
          resolve(ok);
        };
        window[callbackName] = () => settle(true);
        const script = document.createElement('script');
        script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${callbackName}`;
        script.async = true;
        script.onerror = () => settle(false);
        document.head.appendChild(script);
        setTimeout(() => settle(!!window.turnstile), timeout);
        return;
      }

      // Script is already loading (e.g. from index.html preload), poll as fallback
      const timer = setTimeout(() => { clearInterval(check); resolve(!!window.turnstile); }, timeout);
      const check = setInterval(() => {
        if (window.turnstile) {
          clearTimeout(timer);
          clearInterval(check);
          resolve(true);
        }
      }, 50);
    });
  }

  async function resetCaptchaAfterFailure() {
    turnstileToken = null;
    // New challenge session so a failed siteverify does not leave stale state
    challengeReady = refreshChallenge();
    if (captchaMode === 'turnstile' && window.turnstile && turnstileWidgetId != null) {
      try {
        window.turnstile.reset(turnstileWidgetId);
      } catch {
        await initCaptcha();
        return;
      }
      await challengeReady;
      if (challengeId) {
        try {
          await api.post('/challenge/report', { challengeId, turnstileLoaded: true });
        } catch (e) {
          console.error('Challenge re-report failed:', e);
        }
      }
    } else {
      await initCaptcha();
    }
  }

  // Handle form submission
  const form = document.getElementById('login-form');
  const loginBtn = document.getElementById('login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    if (captchaMode === 'pending') {
      showError('请等待人机验证完成');
      return;
    }

    // Prefer callback token; fall back to hidden input Turnstile injects
    if (captchaMode === 'turnstile') {
      if (!turnstileToken) {
        const hidden = document.querySelector('#turnstile-widget input[name="cf-turnstile-response"]');
        turnstileToken = hidden?.value || null;
      }
      if (!turnstileToken) {
        showError('请完成人机验证');
        return;
      }
    }

    if (captchaMode === 'pow' && !powNonce) {
      showError('请等待人机验证完成');
      return;
    }

    setLoading(loginBtn, true);

    try {
      const encryptedPassword = await encryptPassword(password);
      const nonce = generateNonce();
      const fingerprint = getFingerprint();
      const timestamp = Date.now();

      const payload = {
        username,
        p: encryptedPassword,
        nonce,
        fp: fingerprint,
        ts: timestamp,
        challengeId,
        captchaType: captchaMode,
      };

      if (captchaMode === 'turnstile') {
        payload['cf-turnstile-response'] = turnstileToken;
      } else {
        payload.powNonce = powNonce;
      }

      const response = await api.post('/auth/login', payload);

      if (response.token) {
        localStorage.setItem('token', response.token);
        api.setAuthToken(response.token);
        const params = new URLSearchParams(window.location.search);
        navigate(params.get('redirect') || '/');
      }
    } catch (error) {
      showError(error.message || '登录失败，请重试');
      // Always refresh captcha + challenge after any failure (token is single-use)
      await resetCaptchaAfterFailure();
    } finally {
      setLoading(loginBtn, false);
    }
  });

  app.querySelectorAll('a[data-link]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(e.target.getAttribute('href'));
    });
  });
}
