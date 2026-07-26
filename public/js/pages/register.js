// SPDX-License-Identifier: Apache-2.0
import { encryptPassword, generateNonce, getFingerprint, showError, hideMessages, setLoading } from '../utils.js';
import { createCaptcha } from '../captcha.js';

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

  const captcha = createCaptcha({
    api,
    sitekey: turnstileSiteKey,
    widgetEl: document.getElementById('turnstile-widget'),
    statusEl: document.getElementById('pow-status'),
  });

  const form = document.getElementById('register-form');
  const registerBtn = document.getElementById('register-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();

    const username = document.getElementById('username').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const displayName = document.getElementById('display_name').value || null;

    if (password.length < 8) {
      showError('密码长度至少为 8 个字符');
      return;
    }

    setLoading(registerBtn, true);
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
        email,
        p: await encryptPassword(password),
        display_name: displayName,
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

      const response = await api.post('/auth/register', payload);

      if (response.token) {
        localStorage.setItem('token', response.token);
        api.setAuthToken(response.token);
        captcha.destroy();
        const params = new URLSearchParams(window.location.search);
        navigate(params.get('redirect') || '/');
      }
    } catch (error) {
      showError(error.message || '注册失败，请重试');
      await captcha.refreshAfterFailure();
    } finally {
      setLoading(registerBtn, false);
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
