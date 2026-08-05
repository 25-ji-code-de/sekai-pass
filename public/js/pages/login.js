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
      <div id="external-login-slot" class="external-login-slot" hidden>
        <div class="external-divider"><span>OR</span></div>
        <button type="button" id="external-login-btn" class="btn-secondary external-login-trigger">其他登录方式</button>
      </div>
      <div class="link">
        <p>还没有账号？ <a href="/register" data-link>立即注册</a></p>
      </div>
    </div>
    <footer class="site-footer">
      <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a> |
      <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
    </footer>
    <div id="external-login-overlay" class="external-login-overlay" hidden>
      <div class="external-login-dialog" role="dialog" aria-modal="true" aria-labelledby="external-login-title">
        <div class="external-login-head">
          <h2 id="external-login-title">其他登录方式</h2>
          <button type="button" class="external-login-close" aria-label="关闭" title="关闭">&times;</button>
        </div>
        <div id="external-provider-list" class="external-provider-list"></div>
      </div>
    </div>
  `;

  const captcha = createCaptcha({
    api,
    sitekey: turnstileSiteKey,
    widgetEl: document.getElementById('turnstile-widget'),
    statusEl: document.getElementById('pow-status'),
  });

  const form = document.getElementById('login-form');
  const loginBtn = document.getElementById('login-btn');
  const externalSlot = document.getElementById('external-login-slot');
  const externalButton = document.getElementById('external-login-btn');
  const overlay = document.getElementById('external-login-overlay');
  const providerList = document.getElementById('external-provider-list');

  const params = new URLSearchParams(window.location.search);
  const externalError = params.get('external_error');
  if (externalError) showError(externalError);

  function closeExternalLogin() {
    overlay.hidden = true;
    document.body.classList.remove('modal-open');
    externalButton.focus();
  }

  function openExternalLogin() {
    overlay.hidden = false;
    document.body.classList.add('modal-open');
    overlay.querySelector('.external-login-close').focus();
  }

  externalButton.addEventListener('click', openExternalLogin);
  overlay.querySelector('.external-login-close').addEventListener('click', closeExternalLogin);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeExternalLogin();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) closeExternalLogin();
  });

  api.get('/auth/external/providers').then(({ providers }) => {
    if (!Array.isArray(providers) || providers.length === 0) return;
    providerList.replaceChildren();
    for (const provider of providers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `external-provider external-provider--${provider.id}`;

      const icon = document.createElement('img');
      icon.src = provider.icon;
      icon.alt = '';
      icon.width = 22;
      icon.height = 22;
      button.append(icon, document.createTextNode(`使用 ${provider.name} 登录`));
      button.addEventListener('click', async () => {
        setLoading(button, true);
        try {
          const currentParams = new URLSearchParams(window.location.search);
          const result = await api.post(`/auth/external/${encodeURIComponent(provider.id)}/start`, {
            redirect: currentParams.get('redirect') || '/',
          });
          captcha.destroy();
          window.location.assign(result.authorization_url);
        } catch (error) {
          closeExternalLogin();
          showError(error.message || '无法启动第三方登录');
          setLoading(button, false);
        }
      });
      providerList.appendChild(button);
    }
    externalSlot.hidden = false;
  }).catch(() => {
    externalSlot.hidden = true;
  });

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
        const currentParams = new URLSearchParams(window.location.search);
        navigate(currentParams.get('redirect') || '/');
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
