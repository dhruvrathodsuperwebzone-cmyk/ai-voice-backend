const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { COOKIE_NAME } = require("../utils/authCookie");

/**
 * Verify JWT and attach user to req.user.
 * Token: Authorization: Bearer <jwt> OR httpOnly cookie (name from AUTH_COOKIE_NAME, default "token").
 */
const authenticate = async (req, res, next) => {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    } else if (req.cookies && req.cookies[COOKIE_NAME]) {
      token = req.cookies[COOKIE_NAME];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: "Access denied. No token provided." });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await pool.query(
      "SELECT id, name, email, role, phone, created_at FROM users WHERE id = ?",
      [decoded.userId]
    );
    if (!rows || rows.length === 0) {
      return res.status(401).json({ success: false, message: "User not found." });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token expired." });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid token." });
    }
    next(err);
  }
};

/**
 * Optional: restrict by role. Use after authenticate().
 * Example: [authenticate, authorize("admin")]
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: "Not authenticated." });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Insufficient permissions." });
    }
    next();
  };
};

module.exports = { authenticate, authorize };
