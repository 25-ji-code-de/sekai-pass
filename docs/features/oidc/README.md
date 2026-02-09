# OpenID Connect (OIDC) 功能

Sekai Pass 实现了完整的 OpenID Connect 1.0 协议支持，为应用提供标准化的身份认证层。

## 概述

OpenID Connect (OIDC) 是建立在 OAuth 2.0 之上的身份认证协议，提供了一种标准化的方式来验证用户身份并获取用户信息。

### 主要特性

- ✅ **ID Token 生成** - 符合 JWT 标准的 ID Token
- ✅ **UserInfo 端点** - 获取用户详细信息
- ✅ **Discovery 端点** - 自动配置支持
- ✅ **标准声明** - 支持标准 OIDC 声明（sub, name, email 等）
- ✅ **签名验证** - RS256 算法签名和验证
- ✅ **完整流程** - 支持授权码流程 + OIDC

## 支持的流程

### Authorization Code Flow with OIDC

```
1. 客户端请求授权（包含 openid scope）
   ↓
2. 用户登录并授权
   ↓
3. 返回授权码
   ↓
4. 客户端交换令牌（获取 access_token + id_token）
   ↓
5. 验证 ID Token
   ↓
6. 使用 access_token 访问 UserInfo 端点
```

## 核心端点

| 端点 | 路径 | 说明 |
|------|------|------|
| Discovery | `/.well-known/openid-configuration` | OIDC 配置信息 |
| Authorization | `/oauth/authorize` | 授权端点 |
| Token | `/oauth/token` | 令牌端点 |
| UserInfo | `/oauth/userinfo` | 用户信息端点 |
| JWKS | `/.well-known/jwks.json` | 公钥集合 |

## 快速开始

查看以下文档快速开始使用 OIDC：

1. [快速开始指南](quickstart.md) - 5分钟配置 OIDC
2. [实现细节](implementation.md) - 深入了解实现
3. [故障排查](troubleshooting.md) - 解决常见问题

## ID Token 结构

ID Token 是一个 JWT，包含以下声明：

```json
{
  "iss": "https://your-domain.com",
  "sub": "user-id",
  "aud": "client-id",
  "exp": 1234567890,
  "iat": 1234567890,
  "nonce": "random-nonce",
  "name": "User Name",
  "email": "user@example.com",
  "email_verified": true
}
```

## 安全特性

- **签名验证** - 所有 ID Token 使用 ES256 (ECDSA P-256) 签名
- **Nonce 验证** - 防止重放攻击
- **Audience 验证** - 确保令牌用于正确的客户端
- **过期时间** - ID Token 有效期 1 小时
- **HTTPS 强制** - 生产环境强制使用 HTTPS

## 兼容性

Sekai Pass 的 OIDC 实现兼容以下标准：

- OpenID Connect Core 1.0
- OpenID Connect Discovery 1.0
- JSON Web Token (JWT) - RFC 7519
- JSON Web Signature (JWS) - RFC 7515
- JSON Web Key (JWK) - RFC 7517

## 相关文档

- [OAuth 2.1 功能](../oauth/README.md)
- [API 示例](../../api/examples.md)
- [Discovery 端点](../../api/discovery.md)

## 技术支持

如遇到问题，请参考：
- [故障排查指南](troubleshooting.md)
- [实现细节](implementation.md)
