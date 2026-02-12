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
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
}

async function createUser(username, email, passwordHash) {
  const result = await query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at`,
    [username, email, passwordHash]
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
    `SELECT id, username, email, created_at FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

module.exports = {
  pool,
  query,
  initDb,
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserById,
};
