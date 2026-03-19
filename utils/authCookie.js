/**
 * HttpOnly cookie settings for JWT (used by login/register + cleared on logout).
 */
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "token";

function jwtExpiryToMs(exp) {
  const s = String(exp || "7d").trim();
  const m = /^(\d+)([dhms])$/i.exec(s);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u === "d") return n * 24 * 60 * 60 * 1000;
  if (u === "h") return n * 60 * 60 * 1000;
  if (u === "m") return n * 60 * 1000;
  if (u === "s") return n * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

function getCookieOptions() {
  const maxAge = jwtExpiryToMs(process.env.JWT_EXPIRY);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
    path: "/",
  };
}

function clearCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

module.exports = { COOKIE_NAME, getCookieOptions, clearCookieOptions, jwtExpiryToMs };
