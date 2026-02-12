import { showError, setLoading } from '../utils.js';

export async function renderDashboard(app, api, navigate) {
  const token = localStorage.getItem('token');
  if (!token) {
    navigate('/login');
    return;
  }

  api.setAuthToken(token);

  app.innerHTML = `
    <div class="container">
      <div class="logo">
        <img src="/logo.png" alt="SEKAI Pass" width="300" />
      </div>
      <div id="error-message" class="error" style="display: none;"></div>
      <div id="user-info" class="user-info">
        <p><strong>加载中...</strong></p>
      </div>
      <div style="display: flex; gap: 1rem; justify-content: flex-end;">
        <button id="settings-btn" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); width: auto; min-width: 120px;">账号设置</button>
        <button id="logout-btn" class="btn-secondary btn-auto">退出登录</button>
      </div>
      <div style="clear: both;"></div>
    </div>
    <footer class="site-footer">
      <a href="https://docs.nightcord.de5.net/legal/complete/privacy-sekai-pass" target="_blank">隐私政策</a> |
      <a href="https://docs.nightcord.de5.net/legal/complete/terms-sekai-pass" target="_blank">用户服务协议</a>
    </footer>
  `;

  try {
    const user = await api.get('/auth/me', {
      headers: api.getAuthHeaders()
    });

    const userInfoDiv = document.getElementById('user-info');
    userInfoDiv.innerHTML = `
      <p><strong>用户名</strong> <span>${user.username}</span></p>
      <p><strong>邮箱</strong> <span>${user.email}</span></p>
      ${user.display_name ? `<p><strong>昵称</strong> <span>${user.display_name}</span></p>` : ''}
    `;
  } catch (error) {
    showError('获取用户信息失败');
    if (error.status === 401) {
      localStorage.removeItem('token');
      navigate('/login');
    }
  }

  // Handle settings
  const settingsBtn = document.getElementById('settings-btn');
  settingsBtn.addEventListener('click', () => {
    navigate('/settings');
  });

  // Handle logout
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn.addEventListener('click', async () => {
    setLoading(logoutBtn, true);
    try {
      await api.post('/auth/logout', {}, {
        headers: api.getAuthHeaders()
      });
    } catch (error) {
      // Ignore errors on logout
    } finally {
      localStorage.removeItem('token');
      api.setAuthToken(null);
      navigate('/login');
    }
  });
}
