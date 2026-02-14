/**
 * Auth API: register, login, and JWT middleware for Colour Wars.
 */
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("./db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "colour-wars-dev-secret-change-in-production";
const SALT_ROUNDS = 10;

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

router.post("/register", express.json(), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required" });
    }
    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: "Username must be 3–50 characters" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    const trimmedUsername = username.trim().toLowerCase();
    const trimmedEmail = email.trim().toLowerCase();
    const existingUser = await db.findUserByUsername(trimmedUsername);
    if (existingUser) {
      return res.status(409).json({ error: "Username already taken" });
    }
    const existingEmail = await db.findUserByEmail(trimmedEmail);
    if (existingEmail) {
      return res.status(409).json({ error: "Email already registered" });
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await db.createUser(trimmedUsername, trimmedEmail, passwordHash);
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.status(201).json({
      token,
      user: { id: user.id, username: user.username, email: user.email, rating: user.rating ?? 800 },
    });
  } catch (err) {
    if (err.message && err.message.includes("not configured")) {
      return res.status(503).json({ error: "Account system unavailable" });
    }
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    const trimmedUsername = username.trim().toLowerCase();
    const user = await db.findUserByUsername(trimmedUsername);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    const fullUser = await db.findUserById(user.id);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, rating: fullUser?.rating ?? 800 },
    });
  } catch (err) {
    if (err.message && err.message.includes("not configured")) {
      return res.status(503).json({ error: "Account system unavailable" });
    }
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await db.findUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        profile_picture_url: user.profile_picture_url || null,
        rating: user.rating ?? 800,
      },
    });
  } catch (err) {
    if (err.message && err.message.includes("not configured")) {
      return res.status(503).json({ error: "Account system unavailable" });
    }
    console.error("Me error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

router.patch("/profile", authMiddleware, express.json(), async (req, res) => {
  try {
    const { profile_picture_url } = req.body || {};
    const url = typeof profile_picture_url === "string" ? profile_picture_url.trim() : null;
    if (url && url.length > 512) {
      return res.status(400).json({ error: "URL too long" });
    }
    await db.updateProfilePicture(req.userId, url || null);
    const user = await db.findUserById(req.userId);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        profile_picture_url: user.profile_picture_url || null,
        rating: user.rating ?? 800,
      },
    });
  } catch (err) {
    if (err.message && err.message.includes("not configured")) {
      return res.status(503).json({ error: "Account system unavailable" });
    }
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.get("/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const entries = await db.getLeaderboard(limit);
    res.json({ leaderboard: entries });
  } catch (err) {
    if (err.message && err.message.includes("not configured")) {
      return res.status(503).json({ error: "Leaderboard unavailable" });
    }
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

module.exports = { router, authMiddleware, JWT_SECRET };
