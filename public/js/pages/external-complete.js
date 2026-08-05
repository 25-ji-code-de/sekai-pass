// SPDX-License-Identifier: Apache-2.0
import { createHCaptcha } from '../hcaptcha.js';
import { showError, setLoading } from '../utils.js';

function suggestedUsername(profile) {
  const source = profile.email?.split('@')[0] || profile.display_name || '';
  return source.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
}

async function acceptHandoff(api, navigate, ticket) {
  const result = await api.post('/auth/external/handoff', { ticket });
  localStorage.setItem('token', result.token);
  api.setAuthToken(result.token);
  navigate(result.redirect || '/');
}

export async function renderExternalComplete(app, api, navigate) {
  const ticket = new URLSearchParams(window.location.search).get('ticket') || '';
  app.innerHTML = `
    <div class="container external-complete-container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>
      <div id="error-message" class="error" style="display: none;"></div>
      <div id="external-complete-loading" class="external-complete-loading">正在完成登录...</div>
      <div id="external-profile-root"></div>
    </div>
  `;

  if (!ticket) {
    showError('登录票据无效，请重新登录');
    return;
  }

  try {
    await acceptHandoff(api, navigate, ticket);
    return;
  } catch (error) {
    if (error.status !== 410) {
      showError(error.message || '登录失败，请重新登录');
      return;
    }
  }

  let pending;
  try {
    pending = await api.get(`/auth/external/pending?ticket=${encodeURIComponent(ticket)}`);
  } catch (error) {
    showError(error.message || '登录票据已失效，请重新登录');
    return;
  }

  document.getElementById('external-complete-loading').remove();
  const root = document.getElementById('external-profile-root');
  root.innerHTML = `
    <div class="external-profile-provider">
      <img class="provider-icon--${pending.provider.id}" src="${pending.provider.icon}" alt="" width="24" height="24">
      <span>${pending.provider.name}</span>
    </div>
    <h1 class="external-profile-title">完善 SEKAI Pass 资料</h1>
    <form id="external-profile-form">
      <div class="form-group">
        <label for="username">用户名</label>
        <input id="username" name="username" maxlength="50" autocomplete="username" required>
      </div>
      <div class="form-group">
        <label for="email">电子邮箱</label>
        <input id="email" name="email" type="email" maxlength="254" autocomplete="email" required>
      </div>
      <label class="terms-agreement">
        <input type="checkbox" id="agree-terms" required>
        我已阅读并同意
        <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a>
        和
        <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
      </label>
      <div class="form-group captcha-container"><div id="hcaptcha-widget"></div></div>
      <button id="external-profile-submit" type="submit">创建账号并登录</button>
    </form>
    <div class="link"><a href="/login" data-link>返回登录</a></div>
  `;

  const usernameInput = document.getElementById('username');
  const emailInput = document.getElementById('email');
  usernameInput.value = suggestedUsername(pending.profile);
  emailInput.value = pending.profile.email || '';

  const captcha = createHCaptcha({
    api,
    sitekey: window.HCAPTCHA_SITE_KEY || '',
    widgetEl: document.getElementById('hcaptcha-widget'),
  });
  root.querySelector('[data-link]').addEventListener('click', (event) => {
    event.preventDefault();
    captcha.destroy();
    navigate('/login');
  });

  const form = document.getElementById('external-profile-form');
  const submit = document.getElementById('external-profile-submit');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setLoading(submit, true);
    try {
      const proof = await captcha.getProof(8000);
      if (!proof.ok) {
        showError(proof.reason === 'interactive' ? '请先完成人机验证' : '人机验证失败，请重试');
        return;
      }
      const completed = await api.post('/auth/external/complete', {
        ticket,
        username: usernameInput.value.trim(),
        email: emailInput.value.trim(),
        agree_terms: document.getElementById('agree-terms').checked,
        challengeId: proof.challengeId,
        captchaType: proof.type,
        'h-captcha-response': proof.token,
      });
      captcha.destroy();
      await acceptHandoff(api, navigate, completed.handoff_ticket);
    } catch (error) {
      showError(error.message || '创建账号失败，请重试');
      await captcha.refreshAfterFailure();
    } finally {
      setLoading(submit, false);
    }
  });
}
