-- Colour Wars - PostgreSQL schema for user accounts
-- Run this manually if initDb() is not used, or as reference

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  profile_picture_url VARCHAR(512),
  rating INTEGER DEFAULT 800,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Optional: game stats (for future use)
-- CREATE TABLE IF NOT EXISTS user_stats (
--   user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
--   wins_2p INTEGER DEFAULT 0,
--   losses_2p INTEGER DEFAULT 0,
--   wins_4p INTEGER DEFAULT 0,
--   losses_4p INTEGER DEFAULT 0,
--   updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
-- );
