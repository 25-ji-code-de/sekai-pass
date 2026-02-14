import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';
import { solvePoW } from '../pow-solver.js';

export function renderLogin(app, api, navigate) {
  const turnstileSiteKey = window.TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

  let captchaMode = 'pending';
  let challengeId = null;
  let powNonce = null;

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
  const challengeReady = api.get('/challenge/init').then(r => {
    challengeId = r.challengeId;
  }).catch(err => console.error('Challenge init failed:', err));

  // Sequential captcha init: try Turnstile first, fall back to PoW
  initCaptcha();

  async function initCaptcha() {
    try {
      // Wait up to 5s for Turnstile script to be available
      const available = await waitForTurnstile(5000);

      if (available) {
        try {
          const widgetId = window.turnstile.render(turnstileWidget, {
            sitekey: turnstileSiteKey,
            theme: 'dark',
          });
          // render() succeeded — use Turnstile
          await challengeReady;
          if (!challengeId) throw new Error('no challengeId');
          await api.post('/challenge/report', { challengeId, turnstileLoaded: true });
          captchaMode = 'turnstile';
          return;
        } catch (e) {
          // render failed, fall through to PoW
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
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        document.head.appendChild(script);
      }

      const timer = setTimeout(() => { clearInterval(check); resolve(false); }, timeout);
      const check = setInterval(() => {
        if (window.turnstile) {
          clearTimeout(timer);
          clearInterval(check);
          resolve(true);
        }
      }, 100);
    });
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

    if (captchaMode === 'turnstile') {
      const turnstileResponse = document.querySelector('input[name="cf-turnstile-response"]');
      if (!turnstileResponse || !turnstileResponse.value) {
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
        payload['cf-turnstile-response'] = document.querySelector('input[name="cf-turnstile-response"]').value;
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
      if (captchaMode === 'turnstile' && window.turnstile) {
        window.turnstile.reset();
      }
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
