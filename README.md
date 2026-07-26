# SEKAI Pass

<div align="center">

![GitHub License](https://img.shields.io/github/license/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub stars](https://img.shields.io/github/stars/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub forks](https://img.shields.io/github/forks/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub issues](https://img.shields.io/github/issues/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub last commit](https://img.shields.io/github/last-commit/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub repo size](https://img.shields.io/github/repo-size/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
[![CodeFactor](https://img.shields.io/codefactor/grade/github/25-ji-code-de/sekai-pass?style=flat-square&color=884499)](https://www.codefactor.io/repository/github/25-ji-code-de/sekai-pass)

[English](./README.en.md) | 简体中文

</div>

现代化的 SSO (Single Sign-On) 单点登录系统

使用 Cloudflare Workers 和 Lucia Auth 构建的安全认证系统。

## ✨ 特性

- 🔐 Lucia Auth 安全认证（PBKDF2 密码哈希，100,000次迭代）
- ⚡ Cloudflare Workers 边缘部署
- 🗄️ D1 数据库数据持久化
- 🔄 OAuth 2.1 授权码流程（强制 PKCE）
- 🎯 Hono 框架高速路由
- 🚀 **前后端分离架构** - RESTful API + SPA
- 📱 **双系统支持** - 标准 OAuth 2.1 + 现代 API
- 🔒 **强制 PKCE** - 增强所有客户端安全性
- 🆔 **OpenID Connect 1.0** - 完整 OIDC 支持

## 📦 安装配置

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 Cloudflare D1 数据库

```bash
# 创建数据库
npx wrangler d1 create sekai_pass_db
```

将输出的 `database_id` 配置到 `wrangler.toml` 的 `database_id` 字段。

### 3. 应用数据库架构

**全新的库**：

```bash
# 本地开发环境
npx wrangler d1 execute sekai_pass_db --local --file=./schema.sql

# 生产环境
npx wrangler d1 execute sekai_pass_db --remote --file=./schema.sql
```

**已经在跑的库**：上面这条对你没用。`schema.sql` 通篇是
`CREATE TABLE IF NOT EXISTS`，对已存在的表**一列都不会补** —— 它会安静地成功，
然后你在用到新列的接口上收到 500。升级请走：

```bash
npm run migrate              # 本地库
npm run migrate -- --remote  # 线上库
```

它会先读 `pragma_table_info` 看哪几列已经在了，只补缺的那几列；跑几遍、
或者从上次中断的地方接着跑，结果都一样。跑完还会把「没有 owner、因而在
开放平台里看不见」的存量应用列出来，并给出认领用的 SQL。

### 4. 配置 KV 命名空间（OIDC 密钥存储）

```bash
# 创建 KV 命名空间
npx wrangler kv:namespace create "OIDC_KEYS"
npx wrangler kv:namespace create "OIDC_KEYS" --preview
```

将输出的命名空间 ID 更新到 `wrangler.toml`。

### 5. 设置加密密钥

```bash
# 生成随机密钥
openssl rand -hex 32

# 设置 secret
npx wrangler secret put KEY_ENCRYPTION_SECRET
# 粘贴上面生成的密钥
```

### 6. 本地开发

```bash
npm run dev
```

在浏览器中打开 `http://localhost:8787`。

### 7. 部署

```bash
npm run deploy
```

## 🎮 使用方法

### 用户注册和登录

1. 访问 `/register` 创建新账户
2. 访问 `/login` 登录
3. 在仪表板查看用户信息

### OAuth 客户端注册

要将应用集成到 SSO，首先需要注册客户端。

**注意**: 应用管理 UI 正在开发中，需要通过数据库直接注册。

```bash
# 本地开发环境
npx wrangler d1 execute sekai_pass_db --local --command "
INSERT INTO applications (id, name, client_id, client_secret, redirect_uris, created_at)
VALUES (
  'app-' || hex(randomblob(8)),
  'My Application',
  'client-' || hex(randomblob(12)),
  'secret-' || hex(randomblob(16)),
  '[\"http://localhost:3000/callback\",\"http://localhost:8080/callback\"]',
  $(date +%s)000
)
RETURNING client_id, client_secret;"

# 生产环境（使用 --remote 替换 --local）
npx wrangler d1 execute sekai_pass_db --remote --command "..."
```

**重要**: 保存输出的 `client_id` 和 `client_secret`。

### OAuth 2.1 流程

#### 1. 授权请求

将用户重定向到以下 URL（强制 PKCE）：

```
GET https://id.nightcord.de5.net/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&state=RANDOM_STATE
```

**必需参数**:
- `code_challenge`: PKCE 挑战码（code_verifier 的 SHA256 哈希的 Base64URL 编码）
- `code_challenge_method`: 必须为 `S256`
- `state`: 防止 CSRF 的随机字符串（强烈推荐）

**注意**: OAuth 2.1 **强制要求** PKCE。缺少 `code_challenge` 参数的请求将被拒绝。

#### 2. 获取令牌

使用授权码交换访问令牌（强制 PKCE）：

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "client_id=CLIENT_ID" \
  -d "code_verifier=CODE_VERIFIER"
```

**注意**:
- `code_verifier` 是 PKCE 必需的（OAuth 2.1 合规）
- `code_verifier` 是授权请求时 `code_challenge` 对应的原始值
- 公共客户端（SPA、移动应用）不需要 `client_secret`

响应：
```json
{
  "access_token": "access-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh-token",
  "scope": "profile"
}
```

**注意**:
- 访问令牌有效期 1 小时
- 刷新令牌有效期 30 天
- 如果包含 `openid` scope，还会返回 `id_token`（OIDC）

#### 3. 获取用户信息

```bash
curl https://id.nightcord.de5.net/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

响应：
```json
{
  "sub": "user-id",
  "preferred_username": "username",
  "name": "Display Name",
  "picture": "https://storage.nightcord.de5.net/avatars/xxx.webp",
  "bio": "Hello, SEKAI",
  "email": "user@example.com",
  "email_verified": true
}
```

#### 4. 刷新访问令牌

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=REFRESH_TOKEN" \
  -d "client_id=CLIENT_ID"
```

**注意**: 刷新令牌使用后会自动轮换，旧令牌失效。

#### 5. 撤销令牌

```bash
curl -X POST https://id.nightcord.de5.net/oauth/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=TOKEN_TO_REVOKE" \
  -d "token_type_hint=refresh_token"
```

### OpenID Connect (OIDC) 流程

#### 1. 授权请求（包含 openid scope）

```
GET https://id.nightcord.de5.net/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=openid%20profile%20email&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&state=RANDOM_STATE&nonce=RANDOM_NONCE
```

**OIDC 特定参数**:
- `scope`: 必须包含 `openid`
- `nonce`: 防重放攻击的随机值（强烈推荐）

#### 2. 获取令牌（包含 ID Token）

响应将包含 ID Token：
```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "openid profile email",
  "id_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### 3. 验证 ID Token

ID Token 是一个 JWT，包含用户信息：
```json
{
  "iss": "https://id.nightcord.de5.net",
  "sub": "user_id",
  "aud": "client_id",
  "exp": 1234567890,
  "iat": 1234567890,
  "auth_time": 1234567890,
  "nonce": "random_nonce",
  "name": "Display Name",
  "preferred_username": "username",
  "email": "user@example.com",
  "email_verified": true
}
```

## 🗄️ 数据库架构

### users 表
```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    hashed_password TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    bio TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

### sessions 表
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### applications 表
```sql
CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    client_id TEXT NOT NULL UNIQUE,
    client_secret TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,  -- JSON 数组
    created_at INTEGER NOT NULL
);
```

### auth_codes 表
```sql
CREATE TABLE auth_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    code_challenge TEXT,              -- PKCE 挑战码
    code_challenge_method TEXT DEFAULT 'S256',  -- PKCE 方法
    state TEXT,                        -- CSRF 防护参数
    scope TEXT DEFAULT 'profile',      -- 权限范围
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### access_tokens 表
```sql
CREATE TABLE access_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,      -- 1小时有效
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);
```

### refresh_tokens 表
```sql
CREATE TABLE refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,      -- 30天有效
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,             -- 最后使用时间
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);
```

## 🛣️ API 端点

### 前端路由（SPA）

| 路径 | 说明 |
|------|------|
| `/` | 仪表板（需要登录） |
| `/login` | 登录页面 |
| `/register` | 注册页面 |
| `/oauth/authorize` | OAuth 授权页面 |

### RESTful API

所有 API 端点返回 JSON 格式，HTTP 401 表示令牌过期。

#### 认证 API

| 方法 | 路径 | 说明 |
|---------|------|------|
| POST | `/api/auth/login` | 用户登录（返回 token） |
| POST | `/api/auth/register` | 用户注册（返回 token） |
| GET | `/api/auth/me` | 获取当前用户信息 |
| POST | `/api/auth/logout` | 用户登出 |

#### OAuth API

| 方法 | 路径 | 说明 |
|---------|------|------|
| GET | `/api/oauth/app-info` | 获取应用信息 |
| POST | `/api/oauth/authorize` | OAuth 授权（JSON 版本） |

### 标准 OAuth 2.1

| 方法 | 路径 | 说明 |
|---------|------|------|
| GET | `/oauth/authorize` | 授权端点（HTML） |
| POST | `/oauth/authorize` | 授权确认处理（表单） |
| POST | `/oauth/token` | 令牌端点 |
| GET | `/oauth/userinfo` | 用户信息端点 |
| POST | `/oauth/revoke` | 令牌撤销端点 |

### Discovery 端点

| 方法 | 路径 | 说明 |
|---------|------|------|
| GET | `/.well-known/openid-configuration` | OIDC Discovery |
| GET | `/.well-known/oauth-authorization-server` | OAuth Discovery |
| GET | `/.well-known/jwks.json` | JWKS 公钥集 |

## 🔒 安全特性

- ✅ 密码使用 PBKDF2 哈希（100,000次迭代，SHA-256）
- ✅ 会话由 Lucia Auth 管理（30天有效）
- ✅ 生产环境强制 HTTPS
- ✅ 安全 Cookie（SameSite=Lax）
- ✅ 授权码 10 分钟有效
- ✅ 会话自动更新
- ✅ **强制 PKCE** - 所有客户端必须使用
- ✅ **State 参数** - CSRF 防护
- ✅ **短期访问令牌** - 1 小时有效期
- ✅ **令牌轮换** - 刷新令牌使用后自动轮换
- ✅ **Scope 验证** - 细粒度权限控制
- ✅ **ID Token 签名** - ES256 (ECDSA P-256)

## 📚 文档

详细文档请查看 [docs](./docs/) 目录：

- **[文档中心](./docs/README.md)** - 完整文档索引
- **[OIDC 功能](./docs/features/oidc/README.md)** - OpenID Connect 实现
- **[OAuth 2.1 功能](./docs/features/oauth/README.md)** - OAuth 2.1 实现
- **[API 示例](./docs/api/examples.md)** - API 使用示例
- **[Discovery 端点](./docs/api/discovery.md)** - OAuth/OIDC Discovery 文档
- **[示例代码](./examples/README.md)** - 集成示例代码

## 🎨 自定义

### UI 自定义

前端样式文件位于 `public/css/styles.css`，可以直接编辑：

```css
:root {
  --bg-color: #0b0b0e;
  --primary-color: #a48cd6;
  /* 自定义颜色 */
}
```

### 认证流程自定义

- **API 路由**: 编辑 `src/lib/api.ts`
- **OAuth 路由**: 编辑 `src/index.ts`
- **前端页面**: 编辑 `public/js/pages/*.js`

## 📝 开发备注

### 本地测试

```bash
# 启动开发服务器
npm run dev

# 在另一个终端查看 D1 数据库
npx wrangler d1 execute sekai_pass_db --local --command "SELECT * FROM users"
```

### 调试

Cloudflare Workers 日志可以通过 `wrangler tail` 查看：

```bash
npx wrangler tail
```

## 🚀 生产环境部署

### 部署前检查清单

1. ✅ 确认 `wrangler.toml` 配置正确
2. ✅ 在生产环境创建 D1 数据库
3. ✅ 应用数据库架构（schema.sql）
4. ✅ 创建 KV 命名空间用于 OIDC 密钥存储
5. ✅ 设置加密密钥（KEY_ENCRYPTION_SECRET）
6. ✅ 配置 Turnstile（可选，用于防机器人）

### 部署命令

```bash
npm run deploy
```

### 部署后验证

1. 访问 `/.well-known/openid-configuration` 确认 OIDC Discovery 正常
2. 测试用户注册和登录功能
3. 测试 OAuth 2.1 授权流程
4. 检查 Cloudflare Workers 日志确认无错误

## 📄 许可证

Apache License 2.0

详见 [LICENSE](LICENSE) 文件。

## 🌐 SEKAI 生态

本项目是 **SEKAI 生态**的一部分。

查看完整的项目列表和架构：**[SEKAI 门户](https://sekai.nightcord.de5.net)**

## 🤝 贡献

欢迎贡献！我们非常感谢任何形式的贡献。

在贡献之前，请阅读：
- [贡献指南](./CONTRIBUTING.md)
- [行为准则](./CODE_OF_CONDUCT.md)

## 🔒 安全

如果发现安全漏洞，请查看我们的 [安全政策](./SECURITY.md)。

## 📞 联系方式

- **GitHub Issues**: [https://github.com/25-ji-code-de/sekai-pass/issues](https://github.com/25-ji-code-de/sekai-pass/issues)
- **项目主页**: [https://id.nightcord.de5.net](https://id.nightcord.de5.net)
- **哔哩哔哩**: [@bili_47177171806](https://space.bilibili.com/3546904856103196)

## ⭐ Star History

如果这个项目对你有帮助，请给我们一个 Star！

[![Star History Chart](https://api.star-history.com/svg?repos=25-ji-code-de/sekai-pass&type=Date)](https://star-history.com/#25-ji-code-de/sekai-pass&Date)

---

<div align="center">

**[SEKAI 生态](https://sekai.nightcord.de5.net)** 的一部分

Made with 💜 by the [25-ji-code-de](https://github.com/25-ji-code-de) team

</div>
