-- Migration: add personal signature (bio) to users
-- Apply with:
--   npx wrangler d1 execute sekai_pass_db --local --file=./migrations/001_add_bio.sql
--   npx wrangler d1 execute sekai_pass_db --remote --file=./migrations/001_add_bio.sql
ALTER TABLE users ADD COLUMN bio TEXT;
