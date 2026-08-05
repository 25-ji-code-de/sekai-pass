// SPDX-License-Identifier: Apache-2.0

export function renderAbout(app, api, navigate) {
  app.innerHTML = `
    <main class="about-page">
      <section class="about-shell" aria-labelledby="about-title">
        <div class="about-brand">
          <img src="/logo.png" alt="SEKAI Pass" width="300" />
          <span>SEKAI PASS // IDENTITY SERVICE</span>
        </div>
        <div class="about-rule"></div>
        <h1 id="about-title">SEKAI Pass</h1>
        <p class="about-lead">统一、安全的账号与单点登录服务。</p>
        <p class="about-copy">SEKAI Pass 为 SEKAI 生态提供账号登录、OpenID Connect 和 OAuth 2.1 授权。你可以使用密码或已绑定的第三方账号登录，并在登录后管理个人资料与登录方式。</p>
        <div class="about-actions">
          <button type="button" id="about-login-btn">登录</button>
          <button type="button" id="about-register-btn" class="btn-secondary">注册账号</button>
        </div>
        <div class="about-links">
          <a href="/docs.html">开发者文档</a>
          <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank" rel="noopener">隐私政策</a>
          <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank" rel="noopener">用户服务协议</a>
        </div>
      </section>
    </main>
  `;

  document.getElementById('about-login-btn').addEventListener('click', () => navigate('/login'));
  document.getElementById('about-register-btn').addEventListener('click', () => navigate('/register'));
}

