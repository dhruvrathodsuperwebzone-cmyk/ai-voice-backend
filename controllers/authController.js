const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = process.env.JWT_EXPIRY || "7d"; // e.g. "7d", "24h"

/**
 * POST /auth/register
 * Body: { name, email, password, role?, phone? }
 */
const register = async (req, res) => {
  try {
    const { name, email, password, role = "viewer", phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required.",
      });
    }

    const validRoles = ["admin", "agent", "viewer"];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role. Allowed: admin, agent, viewer.",
      });
    }

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing && existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email already registered.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role, phone) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), email.trim().toLowerCase(), hashedPassword, role, phone || null]
    );

    const userId = result.insertId;
    const token = jwt.sign(
      { userId },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    const userObj = {
      id: userId,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      phone: phone || null,
    };
    res.status(201).json({
      success: true,
      message: "User registered successfully.",
      token,
      user: userObj,
      data: {
        user: userObj,
        token,
        expiresIn: TOKEN_EXPIRY,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ success: false, message: "Registration failed." });
  }
};

/**
 * POST /auth/login
 * Body: { email, password }
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const [rows] = await pool.query(
      "SELECT id, name, email, password, role, phone, created_at FROM users WHERE email = ?",
      [email.trim().toLowerCase()]
    );
    if (!rows || rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    const userObj = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      created_at: user.created_at,
    };
    res.json({
      success: true,
      message: "Login successful.",
      token,
      user: userObj,
      data: {
        user: userObj,
        token,
        expiresIn: TOKEN_EXPIRY,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, message: "Login failed." });
  }
};

/**
 * GET /api/profile
 * Headers: Authorization: Bearer <token>
 */
const me = async (req, res) => {
  try {
    res.json({
      success: true,
      data: { user: req.user },
    });
  } catch (err) {
    console.error("Me error:", err);
    res.status(500).json({ success: false, message: "Failed to get user." });
  }
};

/**
 * POST /auth/logout
 * Headers: Authorization: Bearer <token>
 * JWT is stateless; client should discard token. This endpoint confirms logout.
 */
const logout = async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Logged out successfully.",
    });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ success: false, message: "Logout failed." });
  }
};

module.exports = { register, login, me, logout };
