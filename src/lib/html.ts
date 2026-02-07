export const styles = `
  :root {
    --primary-color: #8854d0;
    --primary-gradient: linear-gradient(135deg, #8854d0 0%, #5e35b1 100%);
    --bg-gradient: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    --glass-bg: rgba(30, 30, 50, 0.75);
    --glass-border: rgba(136, 84, 208, 0.2);
    --text-main: #f0f0f0;
    --text-muted: #a0a0a0;
    --input-bg: rgba(0, 0, 0, 0.25);
    --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.4);
    --error-color: #ff6b6b;
    --success-color: #51cf66;
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: 'Inter', 'Noto Sans SC', 'Segoe UI', system-ui, sans-serif;
    background: var(--bg-gradient);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-main);
    position: relative;
    overflow: hidden;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  /* Animated background elements */
  body::before, body::after {
    content: '';
    position: absolute;
    width: 600px;
    height: 600px;
    border-radius: 50%;
    filter: blur(80px);
    opacity: 0.15;
    z-index: 0;
    animation: float 10s ease-in-out infinite alternate;
  }

  body::before {
    background: radial-gradient(circle, #8854d0, transparent 70%);
    top: -100px;
    left: -100px;
  }

  body::after {
    background: radial-gradient(circle, #4834d4, transparent 70%);
    bottom: -100px;
    right: -100px;
    animation-delay: -5s;
  }

  @keyframes float {
    0% { transform: translate(0, 0); }
    100% { transform: translate(30px, 30px); }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .container {
    background: var(--glass-bg);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--glass-border);
    border-radius: 24px;
    padding: 48px;
    width: 90%;
    max-width: 440px;
    box-shadow: var(--shadow-lg);
    position: relative;
    z-index: 1;
    animation: fadeIn 0.8s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .logo {
    text-align: center;
    margin-bottom: 40px;
  }

  .logo h1 {
    font-size: 36px;
    font-weight: 800;
    background: linear-gradient(135deg, #a55eea 0%, #4b7bec 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
    letter-spacing: 1px;
    text-shadow: 0 4px 12px rgba(136, 84, 208, 0.3);
  }

  .logo p {
    font-size: 14px;
    color: var(--text-muted);
    font-weight: 400;
    letter-spacing: 1.5px;
    opacity: 0.8;
    text-transform: uppercase;
  }

  .form-group {
    margin-bottom: 24px;
    position: relative;
  }

  label {
    display: block;
    margin-bottom: 8px;
    font-size: 13px;
    color: #c8c8c8;
    font-weight: 500;
    margin-left: 4px;
  }

  input {
    width: 100%;
    padding: 16px 18px;
    background: var(--input-bg);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    color: var(--text-main);
    font-size: 15px;
    transition: all 0.25s ease;
  }

  input:focus {
    outline: none;
    border-color: #8854d0;
    background: rgba(0, 0, 0, 0.4);
    box-shadow: 0 0 0 4px rgba(136, 84, 208, 0.15);
    transform: translateY(-1px);
  }

  input::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  button {
    width: 100%;
    padding: 16px;
    background: var(--primary-gradient);
    border: none;
    border-radius: 12px;
    color: white;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
    margin-top: 12px;
    box-shadow: 0 4px 15px rgba(136, 84, 208, 0.3);
    position: relative;
    overflow: hidden;
    letter-spacing: 0.5px;
  }

  button::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(rgba(255,255,255,0.1), transparent);
    opacity: 0;
    transition: opacity 0.3s;
  }

  button:hover {
    transform: translateY(-3px);
    box-shadow: 0 8px 25px rgba(136, 84, 208, 0.5);
  }
  
  button:hover::after {
    opacity: 1;
  }

  button:active {
    transform: translateY(-1px);
  }

  .error {
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    color: var(--error-color);
    padding: 14px 18px;
    border-radius: 12px;
    margin-bottom: 24px;
    font-size: 14px;
    display: flex;
    align-items: center;
    backdrop-filter: blur(5px);
  }

  .success {
    background: rgba(81, 207, 102, 0.1);
    border: 1px solid rgba(81, 207, 102, 0.3);
    color: var(--success-color);
    padding: 14px 18px;
    border-radius: 12px;
    margin-bottom: 24px;
    font-size: 14px;
    backdrop-filter: blur(5px);
  }

  .link {
    text-align: center;
    margin-top: 32px;
    font-size: 14px;
    color: var(--text-muted);
  }

  .link a {
    color: #a55eea;
    text-decoration: none;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 6px;
    transition: all 0.2s ease;
  }

  .link a:hover {
    color: #fff;
    background: rgba(136, 84, 208, 0.2);
  }

  .divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 32px 0;
  }

  .user-info {
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 32px;
  }

  .user-info p {
    margin-bottom: 12px;
    font-size: 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    padding-bottom: 10px;
  }
  
  .user-info p:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }

  .user-info strong {
    color: #dcdcdc;
    font-weight: 500;
  }
  
  .user-info span {
    color: #a0a0a0;
  }

  .authorize-actions {
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr 1fr;
  }

  .btn-deny {
    background: linear-gradient(135deg, #ff4757 0%, #ff6b81 100%);
    box-shadow: 0 4px 15px rgba(255, 71, 87, 0.3);
    margin-top: 12px; /* aligns with confirm btn */
  }
  
  .btn-deny:hover {
    box-shadow: 0 8px 25px rgba(255, 71, 87, 0.5);
  }

  /* Authorize Page Specifics */
  .auth-header {
    text-align: center;
    margin-bottom: 32px;
    position: relative;
    animation: fadeIn 0.5s ease-out;
  }
  
  .app-icon {
    width: 72px;
    height: 72px;
    background: var(--primary-gradient);
    border-radius: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    font-weight: 700;
    color: white;
    margin: 0 auto 20px;
    box-shadow: 0 10px 30px rgba(136, 84, 208, 0.4);
    text-transform: uppercase;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .auth-title {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 8px;
    color: var(--text-main);
  }
  
  .auth-subtitle {
    color: var(--text-muted);
    font-size: 15px;
    line-height: 1.5;
  }

  .permission-box {
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 32px;
    animation: fadeIn 0.5s ease-out 0.1s backwards;
  }

  .permission-header {
    margin-bottom: 16px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    font-weight: 600;
  }

  .permission-item {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    font-size: 14px;
    color: #e0e0e0;
    line-height: 1.5;
  }
  
  .permission-icon {
    color: var(--success-color);
    flex-shrink: 0;
    margin-top: 3px;
    filter: drop-shadow(0 0 8px rgba(81, 207, 102, 0.4));
  }

  .permission-title {
    font-weight: 500;
    margin-bottom: 4px;
    display: block;
  }

  .permission-desc {
    color: var(--text-muted);
    font-size: 13px;
  }

  .user-badge {
    display: inline-flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.08);
    padding: 6px 16px;
    border-radius: 50px;
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 16px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  
  .user-badge strong {
    color: var(--text-main);
    margin-left: 6px;
  }
  
  .btn-secondary {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    box-shadow: none;
    margin-top: 0;
    color: var(--text-muted);
  }
  
  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.25);
    color: var(--text-main);
    transform: translateY(-2px);
    box-shadow: none;
  }

  .privacy-note {
    text-align: center;
    margin-top: 24px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.3);
    padding: 0 20px;
    line-height: 1.5;
  }
`;

export function renderPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - SEKAI Pass</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>${styles}</style>
  <script>
    // Client-side encryption utilities
    async function encryptPassword(password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
      const timestamp = Date.now().toString();
      const combined = password + '|' + saltHex + '|' + timestamp;
      const encoder = new TextEncoder();
      const data = encoder.encode(combined);
      return btoa(String.fromCharCode(...data));
    }

    function generateNonce() {
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function getFingerprint() {
      const data = [
        navigator.userAgent,
        navigator.language,
        screen.width + 'x' + screen.height,
        new Date().getTimezoneOffset()
      ].join('|');
      let hash = 0;
      for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return Math.abs(hash).toString(36);
    }

    async function handleFormSubmit(event) {
      event.preventDefault();
      const form = event.target;
      const passwordInput = form.querySelector('input[name="password"]');
      const originalPassword = passwordInput.value;

      // Check Turnstile token
      const turnstileResponse = form.querySelector('input[name="cf-turnstile-response"]');
      if (!turnstileResponse || !turnstileResponse.value) {
        alert('请完成人机验证');
        return false;
      }

      // Encrypt password
      const encryptedPassword = await encryptPassword(originalPassword);

      // Add hidden fields
      const nonce = generateNonce();
      const fingerprint = getFingerprint();
      const timestamp = Date.now();

      // Create hidden inputs
      const fields = {
        'p': encryptedPassword,
        'nonce': nonce,
        'fp': fingerprint,
        'ts': timestamp
      };

      for (const [key, value] of Object.entries(fields)) {
        let input = form.querySelector('input[name="' + key + '"]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = key;
          form.appendChild(input);
        }
        input.value = value;
      }

      // Clear original password
      passwordInput.value = '';
      passwordInput.removeAttribute('name');

      // Submit form
      form.submit();
    }
  </script>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>SEKAI Pass</h1>
    </div>
    ${content}
  </div>
</body>
</html>`;
}

export function loginForm(error?: string, siteKey?: string): string {
  const turnstileSiteKey = siteKey || '1x00000000000000000000AA'; // Default test key
  return renderPage("登录", `
    ${error ? `<div class="error">⚠️ ${error}</div>` : ""}
    <form method="POST" action="/login" onsubmit="handleFormSubmit(event)">
      <div class="form-group">
        <label for="username">用户名</label>
        <input type="text" id="username" name="username" required placeholder="请输入用户名" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" required placeholder="请输入密码" autocomplete="current-password">
      </div>
      <div class="form-group" style="display: flex; justify-content: center;">
        <div class="cf-turnstile" data-sitekey="${turnstileSiteKey}" data-theme="dark"></div>
      </div>
      <button type="submit">登录</button>
    </form>
    <div class="link">
      <p>还没有账号？ <a href="/register">立即注册</a></p>
    </div>
  `);
}

export function registerForm(error?: string, siteKey?: string): string {
  const turnstileSiteKey = siteKey || '1x00000000000000000000AA'; // Default test key
  return renderPage("注册", `
    ${error ? `<div class="error">⚠️ ${error}</div>` : ""}
    <form method="POST" action="/register" onsubmit="handleFormSubmit(event)">
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
      <button type="submit">完成注册</button>
    </form>
    <div class="link">
      <p>已有账号？ <a href="/login">直接登录</a></p>
    </div>
  `);
}

export function dashboardPage(user: any): string {
  return renderPage("仪表盘", `
    <div class="user-info">
      <p><strong>用户名</strong> <span>${user.username}</span></p>
      <p><strong>邮箱</strong> <span>${user.email}</span></p>
      ${user.displayName ? `<p><strong>昵称</strong> <span>${user.displayName}</span></p>` : ""}
    </div>
    <form method="POST" action="/logout">
      <button type="submit" style="background: linear-gradient(135deg, #718093 0%, #2f3640 100%); width: auto; min-width: 120px; float: right;">退出登录</button>
      <div style="clear: both;"></div>
    </form>
  `);
}

export function authorizePage(app: any, user: any): string {
  const initial = app.name ? app.name.charAt(0).toUpperCase() : 'A';
  return renderPage("授权访问", `
    <div class="auth-header">
      <div class="app-icon">${initial}</div>
      <h2 class="auth-title">授权 ${app.name} 访问</h2>
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

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${app.client_id}">
      <input type="hidden" name="redirect_uri" value="${app.redirect_uri}">
      ${app.code_challenge ? `<input type="hidden" name="code_challenge" value="${app.code_challenge}">` : ''}
      ${app.code_challenge_method ? `<input type="hidden" name="code_challenge_method" value="${app.code_challenge_method}">` : ''}

      <div class="authorize-actions">
        <button type="submit" name="action" value="allow">确认授权</button>
        <button type="submit" name="action" value="deny" class="btn-secondary">取消</button>
      </div>
      <div class="privacy-note">
        授权即代表您同意该应用按照其服务条款和隐私政策使用您的信息。
      </div>
    </form>
  `);
}
