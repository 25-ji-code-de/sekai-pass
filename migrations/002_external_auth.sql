-- Third-party login support for existing and social-only accounts.
-- Apply with: npm run migrate -- --remote

ALTER TABLE users ADD COLUMN password_login_enabled INTEGER NOT NULL DEFAULT 1;
