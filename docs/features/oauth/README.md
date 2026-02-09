# OAuth 2.1 功能

Sekai Pass 实现了 OAuth 2.1 协议，提供安全、标准化的授权服务。

## 概述

OAuth 2.1 是 OAuth 2.0 的演进版本，整合了多年来的最佳实践和安全改进，为第三方应用提供安全的授权访问。

### 主要特性

- ✅ **强制 PKCE** - 所有授权流程必须使用 PKCE
- ✅ **State 参数** - 强制 state 参数防止 CSRF
- ✅ **Scope 验证** - 完整的 scope 验证机制
- ✅ **令牌管理** - 访问令牌和刷新令牌管理
- ✅ **令牌撤销** - 支持令牌撤销
- ✅ **安全头部** - Cache-Control 和 Pragma 头部

## OAuth 2.1 特性

OAuth 2.1 包含以下安全特性：

1. **强制 PKCE** - 所有客户端必须使用 PKCE
2. **授权码流程** - 仅支持安全的授权码流程
3. **刷新令牌轮换** - 刷新令牌使用后自动轮换
4. **重定向 URI 精确匹配** - 不允许模糊匹配

## 支持的授权流程

### Authorization Code Flow with PKCE

这是唯一推荐的授权流程：

```
1. 客户端生成 code_verifier 和 code_challenge
   ↓
2. 请求授权（带 code_challenge）
   ↓
3. 用户登录并授权
   ↓
4. 返回授权码
   ↓
5. 客户端交换令牌（带 code_verifier）
   ↓
6. 验证 PKCE 并返回令牌
```

## 核心端点

| 端点 | 路径 | 说明 |
|------|------|------|
| Authorization | `/oauth/authorize` | 授权端点 |
| Token | `/oauth/token` | 令牌端点 |
| Revoke | `/oauth/revoke` | 令牌撤销端点 |
| Discovery | `/.well-known/oauth-authorization-server` | OAuth 配置信息 |

## 令牌类型

### Access Token（访问令牌）
- **格式**: JWT
- **有效期**: 1 小时
- **用途**: 访问受保护资源
- **刷新**: 使用 refresh_token 刷新

### Refresh Token（刷新令牌）
- **格式**: 随机字符串
- **有效期**: 30 天
- **用途**: 获取新的 access_token
- **轮换**: 使用后自动轮换

## 安全特性

### PKCE（Proof Key for Code Exchange）
- 防止授权码拦截攻击
- 支持 S256 和 plain 方法
- 所有客户端强制使用

### State 参数
- 防止 CSRF 攻击
- 所有授权请求强制使用
- 自动验证和清理

### Scope 验证
- 验证请求的 scope 是否有效
- 确保授予的 scope 不超过请求的 scope
- 支持自定义 scope

## 快速开始

查看以下文档了解各个功能：

1. [PKCE 支持](pkce.md) - PKCE 实现文档
2. [令牌系统](token-system.md) - 令牌管理详解
3. [State 参数](state-parameter.md) - State 参数实现
4. [Scope 验证](scope-validation.md) - Scope 验证机制

## 客户端配置

注册 OAuth 客户端时需要提供：

```json
{
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "redirect_uris": ["https://your-app.com/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid profile email"
}
```

## 安全建议

1. **使用 HTTPS** - 生产环境必须使用 HTTPS
2. **保护 Client Secret** - 不要在客户端代码中暴露
3. **验证重定向 URI** - 使用精确匹配
4. **限制 Scope** - 只请求必要的权限
5. **刷新令牌轮换** - 使用后立即更新
6. **令牌过期** - 设置合理的过期时间

## 兼容性

Sekai Pass 的 OAuth 实现兼容以下标准：

- OAuth 2.1 (Draft)
- RFC 6749 - OAuth 2.0
- RFC 7636 - PKCE
- RFC 7009 - Token Revocation
- RFC 8414 - Authorization Server Metadata

## 相关文档

- [OpenID Connect 功能](../oidc/README.md)
- [API 示例](../../api/examples.md)
- [Discovery 端点](../../api/discovery.md)

## 技术支持

如遇到问题，请参考项目文档或提交 Issue。
