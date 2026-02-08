import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';

export function renderRegister(app, api, navigate) {
  const turnstileSiteKey = window.TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

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
        <div class="form-group" style="display: flex; justify-content: center;">
          <div class="cf-turnstile" data-sitekey="${turnstileSiteKey}" data-theme="dark"></div>
        </div>
        <button type="submit" id="register-btn">完成注册</button>
      </form>
      <div class="link">
        <p>已有账号？ <a href="/login" data-link>直接登录</a></p>
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
  const form = document.getElementById('register-form');
  const registerBtn = document.getElementById('register-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();

    const username = document.getElementById('username').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const displayName = document.getElementById('display_name').value || null;
    const turnstileResponse = document.querySelector('input[name="cf-turnstile-response"]');

    if (!turnstileResponse || !turnstileResponse.value) {
      showError('请完成人机验证');
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

      const response = await api.post('/auth/register', {
        username,
        email,
        p: encryptedPassword,
        display_name: displayName,
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
      showError(error.message || '注册失败，请重试');
      // Reset Turnstile
      if (window.turnstile) {
        window.turnstile.reset();
      }
    } finally {
      setLoading(registerBtn, false);
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
