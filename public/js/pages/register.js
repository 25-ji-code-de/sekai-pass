// SPDX-License-Identifier: Apache-2.0
import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';
import { solvePoW } from '../pow-solver.js';
import { mountTurnstile } from '../turnstile-helper.js';

export function renderRegister(app, api, navigate) {
  const turnstileSiteKey = window.TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

  let captchaMode = 'pending';
  let challengeId = null;
  let powNonce = null;
  /** @type {null | Awaited<ReturnType<typeof mountTurnstile>>} */
  let turnstileWidget = null;
  let powFallbackStarted = false;

  app.innerHTML = `
    <div class="container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>
      <div id="error-message" class="error" style="display: none;"></div>
      <form id="register-form">
        <div class="form-group">
          <label for="username">用户名</label>
          <input type="text" id="username" name="username" required placeholder="设置用户名" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="email">电子邮箱</label>
          <input type="email" id="email" name="email" required placeholder="yourname@example.com" autocomplete="email">
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" required placeholder="设置密码" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label for="display_name">昵称（可选）</label>
          <input type="text" id="display_name" name="display_name" placeholder="你想被如何称呼？">
        </div>

        <label class="terms-agreement">
          <input type="checkbox" name="agree_terms" required>
          我已阅读并同意
          <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a>
          和
          <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
        </label>

        <div class="form-group captcha-container">
          <div id="turnstile-widget"></div>
          <div id="pow-status" class="pow-status" style="display: none;"></div>
        </div>
        <button type="submit" id="register-btn">完成注册</button>
      </form>
      <div class="link">
        <p>已有账号？ <a href="/login" data-link>直接登录</a></p>
      </div>
    </div>
    <footer class="site-footer">
      <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a> |
      <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
    </footer>
  `;

  const turnstileContainer = document.getElementById('turnstile-widget');
  const powStatus = document.getElementById('pow-status');

  let challengeReady = refreshChallenge();
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

  function destroyTurnstile() {
    if (turnstileWidget) {
      try {
        turnstileWidget.remove();
      } catch {
        /* ignore */
      }
      turnstileWidget = null;
    }
  }

  async function startPow() {
    if (powFallbackStarted && captchaMode === 'pow') return;
    powFallbackStarted = true;
    destroyTurnstile();
    turnstileContainer.style.display = 'none';
    powStatus.style.display = 'flex';
    powStatus.innerHTML = '<div class="pow-spinner"></div><span>验证环境安全...</span>';
    powStatus.className = 'pow-status';

    challengeReady = refreshChallenge();
    await challengeReady;
    if (!challengeId) {
      powStatus.innerHTML = '<span class="pow-icon">✕</span><span>验证初始化失败，请刷新重试</span>';
      powStatus.className = 'pow-status error';
      captchaMode = 'pending';
      return;
    }

    const result = await api.post('/challenge/report', { challengeId, turnstileLoaded: false });
    powNonce = await solvePoW(result.challenge, result.difficulty);
    captchaMode = 'pow';
    powStatus.innerHTML = '<span class="pow-icon">✓</span><span>环境验证通过</span>';
    powStatus.className = 'pow-status success';
  }

  async function fallbackToPow(reason) {
    if (powFallbackStarted) return;
    console.warn('[Turnstile] falling back to PoW:', reason);
    try {
      await startPow();
    } catch (e) {
      console.error('PoW fallback failed:', e);
      powStatus.style.display = 'flex';
      powStatus.innerHTML = '<span class="pow-icon">✕</span><span>验证失败，请刷新重试</span>';
      powStatus.className = 'pow-status error';
    }
  }

  async function probeTurnstileHost() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      await fetch('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return true;
    } catch {
      return false;
    }
  }

  async function initCaptcha() {
    captchaMode = 'pending';
    powNonce = null;
    powFallbackStarted = false;
    destroyTurnstile();
    turnstileContainer.style.display = '';
    powStatus.style.display = 'none';

    const reachable = await probeTurnstileHost();
    if (!reachable) {
      console.warn('[Turnstile] challenges.cloudflare.com unreachable, using PoW');
      await startPow();
      return;
    }

    try {
      turnstileWidget = await mountTurnstile(turnstileContainer, {
        sitekey: turnstileSiteKey,
        theme: 'dark',
        onFatal: (code) => {
          void fallbackToPow(code);
        },
      });

      if (turnstileWidget) {
        await challengeReady;
        if (!challengeId) throw new Error('no challengeId');
        await api.post('/challenge/report', { challengeId, turnstileLoaded: true });
        captchaMode = 'turnstile';

        void (async () => {
          const token = await turnstileWidget.waitForToken(10000);
          if (!token && captchaMode === 'turnstile') {
            await fallbackToPow('wait-timeout');
          }
        })();
        return;
      }

      await startPow();
    } catch (err) {
      console.error('Captcha init failed:', err);
      try {
        await startPow();
      } catch (powErr) {
        console.error('PoW fallback failed:', powErr);
        powStatus.style.display = 'flex';
        powStatus.innerHTML = '<span class="pow-icon">✕</span><span>验证失败，请刷新重试</span>';
        powStatus.className = 'pow-status error';
      }
    }
  }

  async function resetCaptchaAfterFailure() {
    if (captchaMode === 'turnstile' && turnstileWidget && !turnstileWidget.hadFatalError()) {
      challengeReady = refreshChallenge();
      try {
        turnstileWidget.reset();
        await challengeReady;
        if (challengeId) {
          await api.post('/challenge/report', { challengeId, turnstileLoaded: true });
        }
        return;
      } catch (e) {
        console.error('Challenge re-report failed:', e);
      }
    }
    await initCaptcha();
  }

  const form = document.getElementById('register-form');
  const registerBtn = document.getElementById('register-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();

    const username = document.getElementById('username').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const displayName = document.getElementById('display_name').value || null;

    if (captchaMode === 'pending') {
      showError('请等待人机验证完成');
      return;
    }

    let turnstileToken = null;
    if (captchaMode === 'turnstile') {
      if (turnstileWidget?.hadFatalError()) {
        try {
          await startPow();
        } catch {
          /* ignore */
        }
        showError('人机验证已切换，请再次点击注册');
        return;
      }
      turnstileToken = turnstileWidget?.getToken() || null;
      if (!turnstileToken && turnstileWidget) {
        turnstileToken = await turnstileWidget.waitForToken(8000);
      }
      if (!turnstileToken) {
        try {
          await fallbackToPow('submit-no-token');
          showError('人机验证已切换，请再次点击注册');
        } catch {
          showError('请完成人机验证');
        }
        return;
      }
    }

    if (captchaMode === 'pow' && !powNonce) {
      showError('请等待人机验证完成');
      return;
    }

    if (password.length < 8) {
      showError('密码长度至少为 8 个字符');
      return;
    }

    setLoading(registerBtn, true);

    try {
      const encryptedPassword = await encryptPassword(password);
      const nonce = generateNonce();
      const fingerprint = getFingerprint();
      const timestamp = Date.now();

      const payload = {
        username,
        email,
        p: encryptedPassword,
        display_name: displayName,
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

      const response = await api.post('/auth/register', payload);

      if (response.token) {
        localStorage.setItem('token', response.token);
        api.setAuthToken(response.token);
        destroyTurnstile();
        const params = new URLSearchParams(window.location.search);
        navigate(params.get('redirect') || '/');
      }
    } catch (error) {
      showError(error.message || '注册失败，请重试');
      await resetCaptchaAfterFailure();
    } finally {
      setLoading(registerBtn, false);
    }
  });

  app.querySelectorAll('a[data-link]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      destroyTurnstile();
      navigate(e.target.getAttribute('href'));
    });
  });
}
