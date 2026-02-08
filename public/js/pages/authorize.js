import { showError, getQueryParams, setLoading } from '../utils.js';

export async function renderAuthorize(app, api, navigate) {
  const token = localStorage.getItem('token');
  if (!token) {
    const params = new URLSearchParams(window.location.search);
    navigate(`/login?redirect=/oauth/authorize?${params.toString()}`);
    return;
  }

  api.setAuthToken(token);

  const params = getQueryParams();
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method } = params;

  if (!client_id || !redirect_uri || response_type !== 'code') {
    showError('Invalid request parameters');
    return;
  }

  app.innerHTML = `
    <div class="container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>
      <div id="error-message" class="error" style="display: none;"></div>
      <div id="auth-content">
        <p style="text-align: center;">加载中...</p>
      </div>
    </div>
  `;

  try {
    // Get application info
    const appInfo = await api.get(`/oauth/app-info?client_id=${client_id}`, {
      headers: api.getAuthHeaders()
    });

    // Get user info
    const user = await api.get('/auth/me', {
      headers: api.getAuthHeaders()
    });

    const initial = appInfo.name ? appInfo.name.charAt(0).toUpperCase() : 'A';

    const authContent = document.getElementById('auth-content');
    authContent.innerHTML = `
      <div class="auth-header">
        <div class="app-icon">${initial}</div>
        <h2 class="auth-title">授权 ${appInfo.name} 访问</h2>
        <p class="auth-subtitle">该应用希望通过 SEKAI Pass 登录</p>
        <div class="user-badge">
          <span>当前身份</span>
          <strong>${user.username}</strong>
        </div>
      </div>

      <div class="permission-box">
        <div class="permission-header">请求权限</div>
        <div class="permission-item">
          <svg class="permission-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          <div>
            <span class="permission-title">访问您的公开个人资料</span>
            <div class="permission-desc">该应用可以查看您的用户名、头像及公开ID</div>
          </div>
        </div>
      </div>

      <div class="authorize-actions">
        <button id="allow-btn">确认授权</button>
        <button id="deny-btn" class="btn-secondary">取消</button>
      </div>
      <div class="privacy-note">
        授权即代表您同意该应用按照其服务条款和隐私政策使用您的信息。
      </div>
    `;

    // Handle allow button
    const allowBtn = document.getElementById('allow-btn');
    allowBtn.addEventListener('click', async () => {
      setLoading(allowBtn, true);
      try {
        const response = await api.post('/oauth/authorize', {
          client_id,
          redirect_uri,
          code_challenge,
          code_challenge_method,
          action: 'allow'
        }, {
          headers: api.getAuthHeaders()
        });

        if (response.code) {
          window.location.href = `${redirect_uri}?code=${response.code}`;
        }
      } catch (error) {
        showError(error.message || '授权失败');
        setLoading(allowBtn, false);
      }
    });

    // Handle deny button
    const denyBtn = document.getElementById('deny-btn');
    denyBtn.addEventListener('click', () => {
      window.location.href = `${redirect_uri}?error=access_denied`;
    });

  } catch (error) {
    showError(error.message || '加载应用信息失败');
  }
}
