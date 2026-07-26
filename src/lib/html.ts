/*
 * Copyright 2026 The 25-ji-code-de Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */



export function renderPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - SEKAI Pass</title>
  <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="shortcut icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-title" content="SEKAI Pass" />
  <link rel="manifest" href="/site.webmanifest" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="/logo.png" alt="SEKAI Pass" width="300" />
    </div>
    ${content}
  </div>
</body>
</html>`;
}

export function authorizePage(app: any, user: any): string {
  const initial = app.name ? app.name.charAt(0).toUpperCase() : 'A';
  const userInitial = (user.username || user.email || 'U').charAt(0).toUpperCase();

  // Safe redirect URI display
  let redirectHost = 'Unknown';
  try {
    if (app.redirect_uri) {
      redirectHost = new URL(app.redirect_uri).hostname;
    }
  } catch (e) {}

  // Parse scopes to display
  const scopes = app.scope ? app.scope.split(/\s+/) : ['profile'];

  // Enhanced Scope Definitions
  const scopeDetails: Record<string, { label: string; desc: string; icon: string }> = {
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

  const scopeListHtml = scopes.map((scope: string) => {
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

  return renderPage("授权访问", `
    <div class="auth-flow-container">
      
      <div class="connection-visual">
         <div class="entity user">
           <div class="entity-avatar">
             ${userInitial}
           </div>
           <div class="entity-label">YOU</div>
         </div>
         
         <div class="connection-line">
            <div class="connection-icon">
              <!-- Lock icon -->
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
        应用 <strong>${app.name}</strong> 正在请求访问您的账号
        <br>
        <span class="user-badge-text">
          <span class="text-dimmed">登录身份:</span> ${user.username}
        </span>
      </p>

      <div class="scope-list">
        ${scopeListHtml}
      </div>

      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="client_id" value="${app.client_id}">
        <input type="hidden" name="redirect_uri" value="${app.redirect_uri}">
        ${app.code_challenge ? `<input type="hidden" name="code_challenge" value="${app.code_challenge}">` : ''}
        ${app.code_challenge_method ? `<input type="hidden" name="code_challenge_method" value="${app.code_challenge_method}">` : ''}
        ${app.state ? `<input type="hidden" name="state" value="${app.state}">` : ''}
        ${app.scope ? `<input type="hidden" name="scope" value="${app.scope}">` : ''}
        ${app.nonce ? `<input type="hidden" name="nonce" value="${app.nonce}">` : ''}

        <div class="authorize-actions">
          <button type="submit" name="action" value="allow">允许访问</button>
          <button type="submit" name="action" value="deny" class="btn-secondary">拒绝</button>
        </div>
        
        <div class="privacy-note">
          授权即代表您同意该应用按照其服务条款和隐私政策使用您的公开信息。
        </div>

        <div class="security-context">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          <span>授权后将重定向至: <strong class="text-highlight">${redirectHost}</strong></span>
        </div>
      </form>
    </div>
  `);
}
