# SEKAI Pass

**25時、Nightcordで。** をテーマにした SSO (Single Sign-On) システム

**25-ji, Nightcord de.** themed SSO(Single Sign-On) implecaion

Cloudflare Workers と Lucia Auth を使用した、モダンで安全な認証システムです。

A modern and secure authentication system using Cloudflare Workers and Lucia Auth.


## ✨ 特徴

## ✨ Features

- 🎨 25-ji, Nightcord de. themed dark mode UI
- 🔐 Secure Authentication by Lucia Auth (Scrypt Password Hash)
- ⚡ Can be deployed at Cloudflare Workers
- 🗄️ persistent data storage using Cloudflare D1 database
- 🔄 Support OAuth 2.0 Authorization Code flow
- 🎯 Fast frontend response by Hono Web Framework
- 🚀 Full-stack seperation - RESTful API + SPA
- 📱 Standard OAuth 2.0 + Modern API callback avaliable
- 🔒 OAuth 2.0 PKCE avaliable

## 📦 Deploying

### 1. Install Dependencies
```bash
npm install
```

### 2. Creating D1 Database

```bash
# データベースを作成
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

### 4. Local Development

```bash
npm run dev
```

Open `http://localhost:8787` on your localhost's browser.

### 5. Deploy

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
  'app-001',
  'My Application',
  'my-client-id',
  'my-client-secret',
  '[\"http://localhost:3000/callback\"]',
  $(date +%s)000
);"

# Production(Online)
npx wrangler d1 execute sekai_pass_db --remote --command "..."
```

### Procedure of OAuth 2.0

#### 1. Request for Authentication code

Redirect user to the following URL.

```
GET https://your-domain.workers.dev/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code
```

#### 2. Get the token

Using authentication code for token.

```bash
curl -X POST https://your-domain.workers.dev/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET"
```

Response:

```json
{
  "access_token": "session-token",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

#### 3. Get user info

```bash
curl https://your-domain.workers.dev/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

Response:

```json
{
  "id": "user-id",
  "username": "username",
  "email": "user@example.com",
  "display_name": "Display Name"
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
| POST | `/api/oauth/authorize` | OAuth authorize(JSON) |

### OAuth 2.0 (Compatibility)

| Method | Path | Description |
|---------|------|------|
| GET | `/oauth/authorize` | 认证端点（HTML） |
| POST | `/oauth/authorize` | 认证承认处理（表单） |
| POST | `/oauth/token` | トークンエンドポイント |
| GET | `/oauth/userinfo` | ユーザー情報エンドポイント |

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
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

## 🔒 Security

- ✅ Hashed password with Scrypt algorithm by Oslo Library
- ✅ 30-day session managed by Lucia Auth
- ✅ HTTPS enforcement in production deployment
- ✅ Secrue Cookie（SameSite=Lax）
- ✅ 10-min valid Authentication code 
- ✅ Auto-renew session.

## 📚 Documents

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Detailed information on architecture.
- **[API_EXAMPLES.md](./API_EXAMPLES.md)** - API usage & test examples
- **[MIGRATION.md](./MIGRATION.md)** - Implication of full-stack seperation
- **[PKCE.md](./PKCE.md)** - Procedure of OAuth PKCE 

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
4. Deploy

```bash
npm run deploy
```

## 📄 License

MIT

## 🤝 Contribution

Any kind of contribution are welcomed.
