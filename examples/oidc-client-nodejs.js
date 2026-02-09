// SEKAI Pass - OpenID Connect Node.js 客户端示例
// 使用 openid-client 库实现标准 OIDC 集成

const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');

const app = express();

// 配置
const CONFIG = {
  issuer: 'https://id.nightcord.de5.net',
  clientId: 'demo-client',
  redirectUri: 'http://localhost:3000/callback',
  scope: 'openid profile email'
};

// Session 配置
app.use(session({
  secret: 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // 生产环境设置为 true (需要 HTTPS)
}));

let client;

// 初始化 OIDC 客户端
async function initializeOIDC() {
  try {
    console.log('🔍 正在发现 OIDC 配置...');
    const issuer = await Issuer.discover(CONFIG.issuer);

    console.log('✅ OIDC 配置发现成功:');
    console.log('  - Issuer:', issuer.issuer);
    console.log('  - Authorization Endpoint:', issuer.metadata.authorization_endpoint);
    console.log('  - Token Endpoint:', issuer.metadata.token_endpoint);
    console.log('  - UserInfo Endpoint:', issuer.metadata.userinfo_endpoint);
    console.log('  - JWKS URI:', issuer.metadata.jwks_uri);
    console.log('  - Supported Algorithms:', issuer.metadata.id_token_signing_alg_values_supported);

    client = new issuer.Client({
      client_id: CONFIG.clientId,
      redirect_uris: [CONFIG.redirectUri],
      response_types: ['code'],
    });

    console.log('✅ OIDC 客户端初始化成功\n');
  } catch (error) {
    console.error('❌ OIDC 初始化失败:', error.message);
    process.exit(1);
  }
}

// 首页
app.get('/', (req, res) => {
  if (req.session.user) {
    res.send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SEKAI Pass - 已登录</title>
        <style>
          body {
            font-family: 'Inter', system-ui, sans-serif;
            max-width: 800px;
            margin: 50px auto;
            padding: 20px;
            background: #f9fafb;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          h1 { color: #333; margin-bottom: 10px; }
          .badge {
            display: inline-block;
            background: #10b981;
            color: white;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            margin-left: 10px;
          }
          .info-section {
            background: #f9fafb;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            border-left: 4px solid #3b82f6;
          }
          .info-section h2 {
            font-size: 18px;
            color: #333;
            margin-bottom: 15px;
          }
          .info-grid {
            display: grid;
            grid-template-columns: 150px 1fr;
            gap: 12px;
            font-size: 14px;
          }
          .info-label {
            color: #666;
            font-weight: 600;
          }
          .info-value {
            color: #333;
            font-family: 'Monaco', monospace;
            word-break: break-all;
          }
          .token-display {
            background: #1e293b;
            color: #e2e8f0;
            padding: 16px;
            border-radius: 8px;
            font-family: 'Monaco', monospace;
            font-size: 12px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 200px;
            overflow-y: auto;
            margin-top: 10px;
          }
          button {
            padding: 12px 24px;
            background: #ef4444;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 20px;
          }
          button:hover {
            background: #dc2626;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎉 登录成功 <span class="badge">OIDC</span></h1>

          <div class="info-section">
            <h2>👤 用户信息</h2>
            <div class="info-grid">
              <div class="info-label">用户 ID (sub):</div>
              <div class="info-value">${req.session.user.sub}</div>

              ${req.session.user.name ? `
                <div class="info-label">姓名:</div>
                <div class="info-value">${req.session.user.name}</div>
              ` : ''}

              ${req.session.user.preferred_username ? `
                <div class="info-label">用户名:</div>
                <div class="info-value">${req.session.user.preferred_username}</div>
              ` : ''}

              ${req.session.user.email ? `
                <div class="info-label">邮箱:</div>
                <div class="info-value">${req.session.user.email}</div>
              ` : ''}

              ${req.session.user.email_verified !== undefined ? `
                <div class="info-label">邮箱已验证:</div>
                <div class="info-value">${req.session.user.email_verified ? '✅ 是' : '❌ 否'}</div>
              ` : ''}
            </div>
          </div>

          <div class="info-section">
            <h2>🎫 ID Token Claims</h2>
            <div class="info-grid">
              <div class="info-label">Issuer (iss):</div>
              <div class="info-value">${req.session.user.iss}</div>

              <div class="info-label">Audience (aud):</div>
              <div class="info-value">${req.session.user.aud}</div>

              <div class="info-label">Issued At (iat):</div>
              <div class="info-value">${new Date(req.session.user.iat * 1000).toLocaleString('zh-CN')}</div>

              <div class="info-label">Expires At (exp):</div>
              <div class="info-value">${new Date(req.session.user.exp * 1000).toLocaleString('zh-CN')}</div>

              ${req.session.user.auth_time ? `
                <div class="info-label">Auth Time:</div>
                <div class="info-value">${new Date(req.session.user.auth_time * 1000).toLocaleString('zh-CN')}</div>
              ` : ''}

              ${req.session.user.nonce ? `
                <div class="info-label">Nonce:</div>
                <div class="info-value">${req.session.user.nonce}</div>
              ` : ''}
            </div>
          </div>

          ${req.session.idToken ? `
            <div class="info-section">
              <h2>🔐 ID Token (JWT)</h2>
              <div class="token-display">${req.session.idToken}</div>
            </div>
          ` : ''}

          <form method="POST" action="/logout">
            <button type="submit">🚪 退出登录</button>
          </form>
        </div>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SEKAI Pass - OIDC 演示</title>
        <style>
          body {
            font-family: 'Inter', system-ui, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            width: 100%;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .badge {
            background: #3b82f6;
            color: white;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
          }
          p { color: #666; line-height: 1.6; margin-bottom: 30px; }
          .features {
            background: #f9fafb;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 30px;
          }
          .features h2 {
            font-size: 16px;
            color: #333;
            margin-bottom: 15px;
          }
          .features ul {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          .features li {
            padding: 8px 0;
            padding-left: 24px;
            position: relative;
            color: #666;
            font-size: 14px;
          }
          .features li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #10b981;
            font-weight: bold;
          }
          button {
            width: 100%;
            padding: 14px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
          }
          button:hover {
            transform: translateY(-2px);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔐 SEKAI Pass <span class="badge">OIDC</span></h1>
          <p>使用 OpenID Connect 进行安全的身份验证</p>

          <div class="features">
            <h2>✨ 功能特性</h2>
            <ul>
              <li>标准化的 OIDC 1.0 协议</li>
              <li>ES256 签名的 ID Token</li>
              <li>PKCE 强制保护</li>
              <li>Nonce 防重放攻击</li>
              <li>自动密钥轮换</li>
            </ul>
          </div>

          <form method="GET" action="/login">
            <button type="submit">🚀 使用 OIDC 登录</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }
});

// 登录路由
app.get('/login', (req, res) => {
  // 生成 PKCE 参数
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);

  // 生成 nonce 和 state
  const nonce = generators.nonce();
  const state = generators.state();

  // 保存到 session
  req.session.code_verifier = code_verifier;
  req.session.nonce = nonce;
  req.session.state = state;

  // 构建授权 URL
  const authUrl = client.authorizationUrl({
    scope: CONFIG.scope,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  console.log('🔐 重定向到授权页面...');
  res.redirect(authUrl);
});

// 回调路由
app.get('/callback', async (req, res) => {
  try {
    const params = client.callbackParams(req);

    console.log('📥 收到授权回调');

    // 交换授权码获取 tokens
    const tokenSet = await client.callback(
      CONFIG.redirectUri,
      params,
      {
        code_verifier: req.session.code_verifier,
        state: req.session.state,
        nonce: req.session.nonce,
      }
    );

    console.log('✅ Token 交换成功');
    console.log('  - Access Token:', tokenSet.access_token.substring(0, 20) + '...');
    console.log('  - ID Token:', tokenSet.id_token ? '✓' : '✗');
    console.log('  - Refresh Token:', tokenSet.refresh_token ? '✓' : '✗');

    // 获取用户信息（从 ID Token claims）
    const claims = tokenSet.claims();
    console.log('👤 用户信息:', claims);

    // 保存到 session
    req.session.user = claims;
    req.session.idToken = tokenSet.id_token;
    req.session.accessToken = tokenSet.access_token;
    req.session.refreshToken = tokenSet.refresh_token;

    // 清理临时数据
    delete req.session.code_verifier;
    delete req.session.nonce;
    delete req.session.state;

    res.redirect('/');
  } catch (error) {
    console.error('❌ 回调处理失败:', error.message);
    res.status(500).send(`
      <h1>登录失败</h1>
      <p>错误: ${error.message}</p>
      <a href="/">返回首页</a>
    `);
  }
});

// 退出登录
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ 退出登录失败:', err);
    } else {
      console.log('👋 用户已退出登录');
    }
    res.redirect('/');
  });
});

// 启动服务器
async function start() {
  await initializeOIDC();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('🚀 OIDC 演示应用已启动');
    console.log(`📍 访问: http://localhost:${PORT}`);
    console.log(`🔗 回调 URI: ${CONFIG.redirectUri}`);
    console.log(`🔐 授权服务器: ${CONFIG.issuer}`);
    console.log('\n💡 提示: 请确保在 SEKAI Pass 中注册了客户端应用');
    console.log(`   Client ID: ${CONFIG.clientId}`);
    console.log(`   Redirect URI: ${CONFIG.redirectUri}\n`);
  });
}

start().catch(console.error);
