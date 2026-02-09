"""
SEKAI Pass - OpenID Connect Python Flask 客户端示例
使用 authlib 库实现标准 OIDC 集成
"""

from flask import Flask, session, redirect, url_for, request, render_template_string
from authlib.integrations.flask_client import OAuth
import secrets

app = Flask(__name__)
app.secret_key = secrets.token_hex(32)  # 生产环境请使用环境变量

# 配置
CONFIG = {
    'issuer': 'https://id.nightcord.de5.net',
    'client_id': 'demo-client',
    'redirect_uri': 'http://localhost:5000/callback',
    'scope': 'openid profile email'
}

# 初始化 OAuth
oauth = OAuth(app)

# 注册 OIDC 客户端
oidc = oauth.register(
    name='sekai_pass',
    client_id=CONFIG['client_id'],
    server_metadata_url=f"{CONFIG['issuer']}/.well-known/openid-configuration",
    client_kwargs={
        'scope': CONFIG['scope'],
        'code_challenge_method': 'S256'  # 强制 PKCE
    }
)

# 首页模板
HOME_TEMPLATE = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SEKAI Pass - OIDC Python 演示</title>
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
        a.button {
            display: block;
            width: 100%;
            padding: 14px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            text-align: center;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            transition: transform 0.2s;
        }
        a.button:hover {
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 SEKAI Pass <span class="badge">Python</span></h1>
        <p>使用 OpenID Connect 进行安全的身份验证</p>

        <div class="features">
            <h2>✨ 功能特性</h2>
            <ul>
                <li>Flask + Authlib 集成</li>
                <li>自动 OIDC Discovery</li>
                <li>PKCE S256 保护</li>
                <li>ID Token 自动验证</li>
                <li>Session 管理</li>
            </ul>
        </div>

        <a href="{{ url_for('login') }}" class="button">🚀 使用 OIDC 登录</a>
    </div>
</body>
</html>
"""

# 用户信息页面模板
PROFILE_TEMPLATE = """
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
        a.button {
            display: inline-block;
            padding: 12px 24px;
            background: #ef4444;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            margin-top: 20px;
        }
        a.button:hover {
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
                <div class="info-value">{{ user.sub }}</div>

                {% if user.name %}
                <div class="info-label">姓名:</div>
                <div class="info-value">{{ user.name }}</div>
                {% endif %}

                {% if user.preferred_username %}
                <div class="info-label">用户名:</div>
                <div class="info-value">{{ user.preferred_username }}</div>
                {% endif %}

                {% if user.email %}
                <div class="info-label">邮箱:</div>
                <div class="info-value">{{ user.email }}</div>
                {% endif %}

                {% if user.email_verified is not none %}
                <div class="info-label">邮箱已验证:</div>
                <div class="info-value">{{ '✅ 是' if user.email_verified else '❌ 否' }}</div>
                {% endif %}
            </div>
        </div>

        <div class="info-section">
            <h2>🎫 ID Token Claims</h2>
            <div class="info-grid">
                <div class="info-label">Issuer (iss):</div>
                <div class="info-value">{{ user.iss }}</div>

                <div class="info-label">Audience (aud):</div>
                <div class="info-value">{{ user.aud }}</div>

                <div class="info-label">Issued At (iat):</div>
                <div class="info-value">{{ user.iat }} ({{ format_timestamp(user.iat) }})</div>

                <div class="info-label">Expires At (exp):</div>
                <div class="info-value">{{ user.exp }} ({{ format_timestamp(user.exp) }})</div>

                {% if user.auth_time %}
                <div class="info-label">Auth Time:</div>
                <div class="info-value">{{ user.auth_time }} ({{ format_timestamp(user.auth_time) }})</div>
                {% endif %}

                {% if user.nonce %}
                <div class="info-label">Nonce:</div>
                <div class="info-value">{{ user.nonce }}</div>
                {% endif %}
            </div>
        </div>

        {% if id_token %}
        <div class="info-section">
            <h2>🔐 ID Token (JWT)</h2>
            <div class="token-display">{{ id_token }}</div>
        </div>
        {% endif %}

        <a href="{{ url_for('logout') }}" class="button">🚪 退出登录</a>
    </div>
</body>
</html>
"""


@app.route('/')
def index():
    """首页"""
    if 'user' in session:
        from datetime import datetime

        def format_timestamp(ts):
            return datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')

        return render_template_string(
            PROFILE_TEMPLATE,
            user=session['user'],
            id_token=session.get('id_token'),
            format_timestamp=format_timestamp
        )
    else:
        return render_template_string(HOME_TEMPLATE)


@app.route('/login')
def login():
    """开始 OIDC 登录流程"""
    redirect_uri = url_for('callback', _external=True)
    print(f'🔐 开始 OIDC 登录流程')
    print(f'   Redirect URI: {redirect_uri}')
    return oidc.authorize_redirect(redirect_uri)


@app.route('/callback')
def callback():
    """处理 OIDC 回调"""
    try:
        print('📥 收到授权回调')

        # 交换授权码获取 tokens
        token = oidc.authorize_access_token()

        print('✅ Token 交换成功')
        print(f"   Access Token: {token['access_token'][:20]}...")
        print(f"   ID Token: {'✓' if 'id_token' in token else '✗'}")
        print(f"   Refresh Token: {'✓' if 'refresh_token' in token else '✗'}")

        # 解析 ID Token 获取用户信息
        user_info = token.get('userinfo')
        if not user_info:
            # 如果没有 userinfo，从 ID Token 中提取
            user_info = oidc.parse_id_token(token)

        print(f'👤 用户信息: {user_info}')

        # 保存到 session
        session['user'] = user_info
        session['id_token'] = token.get('id_token')
        session['access_token'] = token.get('access_token')
        session['refresh_token'] = token.get('refresh_token')

        return redirect(url_for('index'))
    except Exception as e:
        print(f'❌ 回调处理失败: {str(e)}')
        return f'<h1>登录失败</h1><p>错误: {str(e)}</p><a href="/">返回首页</a>', 500


@app.route('/logout')
def logout():
    """退出登录"""
    session.clear()
    print('👋 用户已退出登录')
    return redirect(url_for('index'))


if __name__ == '__main__':
    print('🚀 OIDC 演示应用已启动')
    print(f'📍 访问: http://localhost:5000')
    print(f'🔗 回调 URI: {CONFIG["redirect_uri"]}')
    print(f'🔐 授权服务器: {CONFIG["issuer"]}')
    print('\n💡 提示: 请确保在 SEKAI Pass 中注册了客户端应用')
    print(f'   Client ID: {CONFIG["client_id"]}')
    print(f'   Redirect URI: {CONFIG["redirect_uri"]}\n')

    app.run(debug=True, port=5000)
