const bcrypt = require("bcrypt");
const pool = require("../config/db");

const SALT_ROUNDS = 10;
const VALID_ROLES = ["admin", "agent", "viewer"];

function userPublic(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * GET /api/users?page=1&limit=20&search=&role=
 * Admin only — list all users (no password field).
 */
async function list(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = req.query.search && String(req.query.search).trim();
    const roleFilter = req.query.role && String(req.query.role).trim();

    const where = [];
    const params = [];
    if (search) {
      where.push("(u.name LIKE ? OR u.email LIKE ?)");
      const term = `%${search}%`;
      params.push(term, term);
    }
    if (roleFilter && VALID_ROLES.includes(roleFilter)) {
      where.push("u.role = ?");
      params.push(roleFilter);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
    const total = countRow.total;

    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.phone, u.created_at, u.updated_at
       FROM users u ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows.map(userPublic),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("List users error:", err);
    res.status(500).json({ success: false, message: "Failed to list users." });
  }
}

/**
 * POST /api/users
 * Admin only — create a user (same fields as register, no auto-login token).
 * Body: { name, email, password, role?, phone? }
 */
async function create(req, res) {
  try {
    const { name, email, password, role = "viewer", phone } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "name, email, and password are required.",
      });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Invalid role. Allowed: ${VALID_ROLES.join(", ")}.`,
      });
    }

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email.trim().toLowerCase()]);
    if (existing && existing.length > 0) {
      return res.status(409).json({ success: false, message: "Email already registered." });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role, phone) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), email.trim().toLowerCase(), hashedPassword, role, phone ? String(phone).trim() : null]
    );

    const [rows] = await pool.query(
      "SELECT id, name, email, role, phone, created_at, updated_at FROM users WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: "User created.",
      data: userPublic(rows[0]),
    });
  } catch (err) {
    console.error("Admin create user error:", err);
    res.status(500).json({ success: false, message: "Failed to create user." });
  }
}

module.exports = { list, create };
