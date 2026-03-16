/**
 * Run this to create all tables: node scripts/createTables.js
 * Uses .env for DB connection (DB_NAME=ai_agent_voice, etc.)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  const sqlPath = path.join(__dirname, "..", "database", "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  try {
    await connection.query(sql);
    console.log("All tables created successfully: users, hotels, leads, campaigns, calls, payments, meetings");
  } catch (err) {
    console.error("Error creating tables:", err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

run();
