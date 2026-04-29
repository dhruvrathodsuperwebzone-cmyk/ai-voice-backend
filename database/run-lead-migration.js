/**
 * One-time script to add missing columns to `leads` table.
 * Run from project root: node database/run-lead-migration.js
 * Requires DB credentials in .env (same as the API).
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mysql = require("mysql2/promise");

const ALTERS = [
  "ALTER TABLE leads ADD COLUMN hotel_name VARCHAR(255)",
  "ALTER TABLE leads ADD COLUMN owner_name VARCHAR(255)",
  "ALTER TABLE leads ADD COLUMN rooms INT",
  "ALTER TABLE leads ADD COLUMN location VARCHAR(255)",
];

async function run() {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    console.log("Connected to database:", process.env.DB_NAME);

    for (const sql of ALTERS) {
      try {
        await conn.query(sql);
        const col = sql.match(/ADD COLUMN (\w+)/)?.[1] || "column";
        console.log("  Added column:", col);
      } catch (e) {
        const isDup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
        if (isDup) {
          const col = sql.match(/ADD COLUMN (\w+)/)?.[1] || "column";
          console.log("  Column already exists:", col);
        } else {
          console.error("  Failed:", sql, e.message);
          throw e;
        }
      }
    }
    console.log("Lead migration finished. hotel_name, owner_name, rooms, location are now available.");
  } finally {
    if (conn) await conn.end();
  }
}

run().catch((err) => {
  console.error("Migration error:", err.message);
  process.exit(1);
});
