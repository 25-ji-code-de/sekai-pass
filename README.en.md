# SEKAI Pass - A SSO (Single Sign-On) implication

<div align="center">

![GitHub License](https://img.shields.io/github/license/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub stars](https://img.shields.io/github/stars/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub forks](https://img.shields.io/github/forks/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub issues](https://img.shields.io/github/issues/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub last commit](https://img.shields.io/github/last-commit/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
![GitHub repo size](https://img.shields.io/github/repo-size/25-ji-code-de/sekai-pass?style=flat-square&color=884499)
[![CodeFactor](https://img.shields.io/codefactor/grade/github/25-ji-code-de/sekai-pass?style=flat-square&color=884499)](https://www.codefactor.io/repository/github/25-ji-code-de/sekai-pass)

English | [简体中文](./README.md)

</div>

A modern and secure authentication system using Cloudflare Workers and Lucia Auth.


## ✨ Features

- 🔐 Secure Authentication by Lucia Auth (PBKDF2 Password Hash, 100,000 iterations)
- ⚡ Can be deployed at Cloudflare Workers
- 🗄️ persistent data storage using Cloudflare D1 database
- 🔄 Support OAuth 2.1 Authorization Code flow with PKCE enforcement
- 🎯 Fast frontend response by Hono Web Framework
- 🚀 Full-stack seperation - RESTful API + SPA
- 📱 Standard OAuth 2.0 + Modern API callback avaliable
- 🆔 Full implication of **OpenID Connect 1.0**

## 📦 Deploying

### 1. Install Dependencies
```bash
npm install
```

### 2. Creating D1 Database

```bash
# Create database
npx wrangler d1 create sekai_pass_db
```

Then, fill the `database_id` in the `wrangler.toml` with the `database_id` showed in the output.

### 3. Create Database Structure

```bash
# Development(Local)
npx wrangler d1 execute sekai_pass_db --local --file=./schema.sql

# Production(Online)
npx wrangler d1 execute sekai_pass_db --remote --file=./schema.sql
```

### 4. Configure KV Namespace for OIDC_KEYS storage

```bash
# Create KV Namespace
npx wrangler kv:namespace create "OIDC_KEYS"
npx wrangler kv:namespace create "OIDC_KEYS" --preview
```

Update `wrangler.toml` with Namespace ID in the output.

### 5. Generate Encrypt Secret

```bash
# Generate Ramdom Secret
openssl rand -hex 32

# Set secret
npx wrangler secret put KEY_ENCRYPTION_SECRET
# Paste the generated secret into the prompt.
```


### 6. Local Development

```bash
npm run dev
```

Open `http://localhost:8787` on your localhost's browser.

### 7. Deploy

```bash
npm run deploy
```

## 🎮 Usage

### Register & Login

1. `/register` for user registration.
2. `/login` for user login.
3. Get user information in the dashboard.

### Register your application using OAuth 

To integrate SSO into your application , it's nescessary to register your application first.

```bash
# Development(Local)
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

# Production(Online), use --remote switch instead of --local
npx wrangler d1 execute sekai_pass_db --remote --command "..."
```

**IMPORTANT**: Save the `client_id` and `client_secret` in the output.

### Procedure of OAuth 2.1

#### 1. Request for Authentication code


```
GET https://id.nightcord.de5.net/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&state=RANDOM_STATE
```

**Parameters**:

- `code_challenge`: PKCE challenge value, derived from the code_verifier using SHA-256 and Base64URL encoding.
- `code_challenge_method`: Must be `S256`
- `state`: Random string to against CSRF attack.(Recommend)

**WARNING**: It's an **enforcement** to PKCE's existance in OAuth 2.1. Request without `code_challenge` will be refused.

#### 2. Get the token

Using authentication code for token. (PKCE enforcement)

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "client_id=CLIENT_ID" \
  -d "code_verifier=CODE_VERIFIER"
```

**Notes**:
- It's an **enforcement** to PKCE's existance in OAuth 2.1. (See part 1)
- `code_verifier` is the raw string of `code_challenge` got in previous step: `Request for Authentication code`.
- Public client, like SPA and mobile application do not need `client_secret`.

Response:

```json
{
  "access_token": "access-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh-token",
  "scope": "profile"
}
```

**Notes**:
- `access_token` valids in 1hr
- `refresh_token` valids in 30d
- `id_token` will included in response if `openid` scope is included.

#### 3. Get user info

```bash
curl https://id.nightcord.de5.net/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

Response:

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

#### 4. Refresh Access Token

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=REFRESH_TOKEN" \
  -d "client_id=CLIENT_ID"
```

**WARNING**: After a refresh token is used, it will automatically rotate, and the old token will expire.

#### 5. Revoke Token

```bash
curl -X POST https://id.nightcord.de5.net/oauth/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=TOKEN_TO_REVOKE" \
  -d "token_type_hint=refresh_token"
```

### OpenID Connect (OIDC) Procedure

#### 1. Authorization Request（With `openid` scope）

```
GET https://id.nightcord.de5.net/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=openid%20profile%20email&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&state=RANDOM_STATE&nonce=RANDOM_NONCE
```

**OIDC Specified Parameters**:
- `scope`: Must include `openid`
- `nonce`: Random string against replay attack(Recommend)

#### 2. Get Token(With ID Token)

Response(ID Token included):

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

#### 3. Verify ID Token

ID Token is a JWT containing user information：
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

## 🛣️ API Endpoint

### Single Page Application

| Path | Description |
|------|------|
| `/` | Dashboard (Login Required) |
| `/login` | Login |
| `/register` | Register |
| `/oauth/authorize` | OAuth Authentication |

### RESTful API（New）

JSON is the response format of all API Endpoint. HTTP 401 indicates an expired token.

#### Standard Authorization API

| Method | Path | Description |
|---------|------|------|
| POST | `/api/auth/login` | Login (Response: token) |
| POST | `/api/auth/register` | Register (Response: token) |
| GET | `/api/auth/me` | Information |
| POST | `/api/auth/logout` | Logout |

#### OAuth Extension API

| Method | Path | Description |
|---------|------|------|
| GET | `/api/oauth/app-info` | Application information|
| POST | `/api/oauth/authorize` | OAuth authorize (JSON) |

### OAuth 2.1

| Method | Path | Description |
|---------|------|------|
| GET | `/oauth/authorize` | Authorization(HTML) |
| POST | `/oauth/authorize` | Authorization Processing(Lists) |
| POST | `/oauth/token` | Token |
| GET | `/oauth/userinfo` | User Information |
| POST | `/oauth/revoke` | Token Revoke |

### Discovery Endpoint

| Method | Path | Description |
|---------|------|------|
| GET | `/.well-known/openid-configuration` | OIDC Discovery |
| GET | `/.well-known/oauth-authorization-server` | OAuth Discovery |
| GET | `/.well-known/jwks.json` | JWKS Public Keys Set |

## 🗄️ Database Structure

### TABLE users 
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

### TABLE sessions
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### TABLE applications
```sql
CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    client_id TEXT NOT NULL UNIQUE,
    client_secret TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,  -- JSON array
    created_at INTEGER NOT NULL
);
```

### TABLE auth_codes
```sql
CREATE TABLE auth_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    code_challenge TEXT,              -- PKCE Challenge Code
    code_challenge_method TEXT DEFAULT 'S256',  -- PKCE Method
    state TEXT,                        -- Anti CSRF String
    scope TEXT DEFAULT 'profile',      -- Permission Range
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```
### TABLE access_tokens
```sql
CREATE TABLE access_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,      -- Valid for 1 hour
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);
```

### TABLE refresh_tokens
```sql
CREATE TABLE refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,      -- Valid for 30 days
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,             -- Last Used Time
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);
```


## 🔒 Security

- ✅ Hashed password with PBKDF2 algorithm (100,000 iterations, SHA-256)
- ✅ 30-day session managed by Lucia Auth
- ✅ HTTPS enforcement in production deployment
- ✅ Secrue Cookie（SameSite=Lax）
- ✅ 10-min valid authentication code 
- ✅ Auto-renew session
- ✅ Enforcement PKCE for all client
- ✅ Anti CSRF by `state` string 
- ✅ Short-term access token - valid for 1 hour
- ✅ Refresh token automatically rotates after use 
- ✅ **Scope Verification** - Fine-grained permission control
- ✅ **ID Token Signing** - ES256 (ECDSA P-256)

## 📚 Documents

For detailed documents, see [docs](./docs/).

- **[Doc Center](./docs/README.md)** - Index of docs
- **[OIDC Function](./docs/features/oidc/README.md)** - OpenID Connect implication
- **[OAuth 2.1 Function](./docs/features/oauth/README.md)** - OAuth 2.1 implecaion
- **[API Example](./docs/api/examples.md)** - API usage examples
- **[Discovery Endpoint](./docs/api/discovery.md)** - OAuth/OIDC Discovery 
- **[Examples](./examples/README.md)** - Integration example

## 🎨 Customization

### UI Customization

Located at `public/css/styles.css`, the frontend style can be easily modified：

```css
:root {
  --bg-color: #0b0b0e;
  --primary-color: #a48cd6;
  /* customised background color */
}
```

### Authentication flow customization 

- **API**: `src/lib/api.ts`
- **OAuth**: `src/index.ts`
- **Frontend**: `public/js/pages/*.js`

## 📝 Development Notes

### Local testing

```bash
# Launch Development Server
npm run dev

# In another terminal, verify the D1 database
npx wrangler d1 execute sekai_pass_db --local --command "SELECT * FROM users"
```

### Debugging

The log of Cloudflare Workers can be checked by running `wrangler tail`

```bash
npx wrangler tail
```

## 🚀 Deploy to production

1. Check the configration of `wrangler.toml`
2. Create database in production
3. Create database structure
4. Set the encryption secret
4. Deploy

```bash
npm run deploy
```

## 📄 License

Apache License 2.0

## 🤝 Contribution

Any kind of contribution are welcomed.
