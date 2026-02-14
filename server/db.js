/**
 * PostgreSQL database connection and queries for Colour Wars.
 * Uses connection string from DATABASE_URL environment variable.
 */
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
  : null;

if (pool) {
  pool.on("error", (err) => {
    console.error("Unexpected database error:", err);
  });
}

async function query(text, params) {
  if (!pool) throw new Error("Database not configured (DATABASE_URL missing)");
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      profile_picture_url VARCHAR(512),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
  try {
    await query(`ALTER TABLE users ADD COLUMN profile_picture_url VARCHAR(512)`);
  } catch (e) {
    if (e.code !== "42701") throw e;
  }
  try {
    await query(`ALTER TABLE users ADD COLUMN rating INTEGER DEFAULT 800`);
  } catch (e) {
    if (e.code !== "42701") throw e;
  }
  await query(`UPDATE users SET rating = 800 WHERE rating IS NULL`);
}

const DEFAULT_RATING = 800;

async function createUser(username, email, passwordHash) {
  const result = await query(
    `INSERT INTO users (username, email, password_hash, rating) VALUES ($1, $2, $3, $4) RETURNING id, username, email, rating, created_at`,
    [username, email, passwordHash, DEFAULT_RATING]
  );
  return result.rows[0];
}

async function findUserByUsername(username) {
  const result = await query(
    `SELECT id, username, email, password_hash, created_at FROM users WHERE username = $1`,
    [username]
  );
  return result.rows[0];
}

async function findUserByEmail(email) {
  const result = await query(
    `SELECT id, username, email, password_hash, created_at FROM users WHERE email = $1`,
    [email]
  );
  return result.rows[0];
}

async function findUserById(id) {
  const result = await query(
    `SELECT id, username, email, profile_picture_url, ROUND(COALESCE(rating, 800))::INTEGER AS rating, created_at FROM users WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (row && row.rating != null) row.rating = Math.round(row.rating);
  return row;
}

async function updateProfilePicture(userId, url) {
  await query(
    `UPDATE users SET profile_picture_url = $1, updated_at = NOW() WHERE id = $2`,
    [url || null, userId]
  );
}

async function getRatingsForUserIds(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");
  const result = await query(
    `SELECT id, ROUND(COALESCE(rating, 800))::INTEGER AS rating FROM users WHERE id IN (${placeholders})`,
    userIds
  );
  const byId = {};
  for (const row of result.rows) byId[row.id] = Math.round(row.rating);
  return userIds.map((id) => Math.round(byId[id] ?? 800));
}

async function updateUserRating(userId, delta) {
  await query(
    `UPDATE users SET rating = ROUND(GREATEST(0, COALESCE(rating, 800) + $1))::INTEGER, updated_at = NOW() WHERE id = $2`,
    [delta, userId]
  );
}

module.exports = {
  pool,
  query,
  initDb,
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  updateProfilePicture,
  getRatingsForUserIds,
  updateUserRating,
};
