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
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } = params;

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
    const userInitial = (user.username || 'U').charAt(0).toUpperCase();

    // Parse scopes to display
    const scopeParam = getQueryParams().scope;
    const scopes = scopeParam ? scopeParam.split(/\s+|%20|\+/) : ['profile']; 

    const scopeDetails = {
      'openid': {
        label: 'OpenID 身份',
        desc: '验证您的用户身份 (OpenID Connect)',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="12" cy="10" r="3"></circle><path d="M7 20v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"></path></svg>'
      },
      'profile': {
        label: '用户资料',
        desc: '访问您的基础信息（用户名、昵称、头像）',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'
      },
      'email': {
        label: '电子邮件',
        desc: '访问您的电子邮箱地址 (email)',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>'
      },
      'applications': {
        label: '应用管理',
        desc: '代表您创建和管理所有 OAuth 应用程序',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>'
      },
      'admin': {
        label: '系统管理',
        desc: '拥有系统的完全管理员控制权限 (危险)',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>'
      }
    };
  
    const defaultIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>';

    const scopeListHtml = scopes.map(scope => {
      const detail = scopeDetails[scope] || { label: scope, desc: '未知的权限类型', icon: defaultIcon };
      return `
        <div class="scope-item">
          <div class="scope-icon-box">
            ${detail.icon}
          </div>
          <div class="scope-content">
            <div class="scope-name">
              ${detail.label}
              <span class="scope-tag">${scope}</span>
            </div>
            <div class="scope-desc">${detail.desc}</div>
          </div>
        </div>
      `;
    }).join('');

    let redirectHost = 'Unknown';
    try {
        redirectHost = new URL(redirect_uri).hostname;
    } catch(e) {}

    const authContent = document.getElementById('auth-content');
    authContent.innerHTML = `
      <div class="auth-flow-container">
        
        <div class="connection-visual">
           <div class="entity user">
             <div class="entity-avatar" style="background: linear-gradient(135deg, #4b5563 0%, #1f2937 100%);">
               ${userInitial}
             </div>
             <div class="entity-label">YOU</div>
           </div>
           
           <div class="connection-line">
              <div class="connection-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              </div>
           </div>

           <div class="entity app">
             <div class="entity-avatar">
               ${initial}
             </div>
             <div class="entity-label">APP</div>
           </div>
        </div>

        <h2 class="auth-title-large">授权访问请求</h2>
        <p class="auth-subtitle-large">
          应用 <strong>${appInfo.name}</strong> 正在请求访问您的账号
          <br>
          <span class="user-badge-text" style="font-size: 11px; margin-top: 6px; display: inline-block; padding: 2px 8px; background: rgba(255,255,255,0.05); border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);">
            <span style="opacity: 0.6;">登录身份:</span> <strong style="color: var(--text-main);">${user.username}</strong>
          </span>
        </p>

        <div class="scope-list">
          ${scopeListHtml}
        </div>

        <div class="authorize-actions">
          <button id="allow-btn">允许访问</button>
          <button id="deny-btn" class="btn-secondary">拒绝</button>
        </div>
        
        <div class="privacy-note">
          授权即代表您同意该应用按照其服务条款和隐私政策使用您的公开信息。
        </div>
        
        <div class="security-context">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          <span>授权后将重定向至: <strong style="color: var(--text-main);">${redirectHost}</strong></span>
        </div>
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
          state,
          action: 'allow'
        }, {
          headers: api.getAuthHeaders()
        });

        if (response.code) {
          const redirectUrl = new URL(redirect_uri);
          redirectUrl.searchParams.set('code', response.code);
          if (state) {
            redirectUrl.searchParams.set('state', state);
          }
          window.location.href = redirectUrl.toString();
        }
      } catch (error) {
        showError(error.message || '授权失败');
        setLoading(allowBtn, false);
      }
    });

    // Handle deny button
    const denyBtn = document.getElementById('deny-btn');
    denyBtn.addEventListener('click', () => {
      const errorUrl = new URL(redirect_uri);
      errorUrl.searchParams.set('error', 'access_denied');
      if (state) {
        errorUrl.searchParams.set('state', state);
      }
      window.location.href = errorUrl.toString();
    });

  } catch (error) {
    showError(error.message || '加载应用信息失败');
  }
}
