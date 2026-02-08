import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';

export function renderLogin(app, api, navigate) {
  const turnstileSiteKey = window.TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

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
        <div class="form-group" style="display: flex; justify-content: center;">
          <div class="cf-turnstile" data-sitekey="${turnstileSiteKey}" data-theme="dark"></div>
        </div>
        <button type="submit" id="login-btn">登录</button>
      </form>
      <div class="link">
        <p>还没有账号？ <a href="/register" data-link>立即注册</a></p>
      </div>
    </div>
  `;

  // Load Turnstile script
  if (!document.querySelector('script[src*="turnstile"]')) {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  // Handle form submission
  const form = document.getElementById('login-form');
  const loginBtn = document.getElementById('login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const turnstileResponse = document.querySelector('input[name="cf-turnstile-response"]');

    if (!turnstileResponse || !turnstileResponse.value) {
      showError('请完成人机验证');
      return;
    }

    setLoading(loginBtn, true);

    try {
      const encryptedPassword = await encryptPassword(password);
      const nonce = generateNonce();
      const fingerprint = getFingerprint();
      const timestamp = Date.now();

      const response = await api.post('/auth/login', {
        username,
        p: encryptedPassword,
        nonce,
        fp: fingerprint,
        ts: timestamp,
        'cf-turnstile-response': turnstileResponse.value
      });

      if (response.token) {
        localStorage.setItem('token', response.token);
        api.setAuthToken(response.token);
        navigate('/');
      }
    } catch (error) {
      showError(error.message || '登录失败，请重试');
      // Reset Turnstile
      if (window.turnstile) {
        window.turnstile.reset();
      }
    } finally {
      setLoading(loginBtn, false);
    }
  });

  // Handle navigation links
  app.querySelectorAll('a[data-link]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(e.target.getAttribute('href'));
    });
  });
}
