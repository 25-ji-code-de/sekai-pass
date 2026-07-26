// SPDX-License-Identifier: Apache-2.0
import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';
import { createCaptcha } from '../captcha.js';

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

  const captcha = createCaptcha({
    api,
    sitekey: turnstileSiteKey,
    widgetEl: document.getElementById('turnstile-widget'),
    statusEl: document.getElementById('pow-status'),
  });

  const form = document.getElementById('login-form');
  const loginBtn = document.getElementById('login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    setLoading(loginBtn, true);
    try {
      const proof = await captcha.getProof(8000);
      if (!proof.ok) {
        if (proof.reason === 'interactive') {
          showError('请先完成上方的人机验证');
        } else if (proof.reason === 'failed') {
          showError('人机验证失败，请刷新页面重试');
        } else {
          showError('人机验证还在进行中，请稍候再试');
        }
        return;
      }

      const payload = {
        username,
        p: await encryptPassword(password),
        nonce: generateNonce(),
        fp: getFingerprint(),
        ts: Date.now(),
        challengeId: proof.challengeId,
        captchaType: proof.type,
      };
      if (proof.type === 'turnstile') {
        payload['cf-turnstile-response'] = proof.token;
      } else {
        payload.powNonce = proof.nonce;
      }

      const response = await api.post('/auth/login', payload);

      if (response.token) {
        localStorage.setItem('token', response.token);
        api.setAuthToken(response.token);
        captcha.destroy();
        const params = new URLSearchParams(window.location.search);
        navigate(params.get('redirect') || '/');
      }
    } catch (error) {
      showError(error.message || '登录失败，请重试');
      await captcha.refreshAfterFailure();
    } finally {
      setLoading(loginBtn, false);
    }
  });

  app.querySelectorAll('a[data-link]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      captcha.destroy();
      navigate(e.target.getAttribute('href'));
    });
  });
}
