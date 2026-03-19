const pool = require("../config/db");

let tableChecked = false;
async function ensureScriptsTable() {
  if (tableChecked) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS scripts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255),
      flow TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );
  tableChecked = true;
}

function parseFlow(flow) {
  if (flow == null) return null;
  if (typeof flow === "string") {
    try {
      return JSON.parse(flow);
    } catch {
      return flow;
    }
  }
  return flow;
}

function scriptRowToObject(row) {
  return {
    id: row.id,
    name: row.name ?? null,
    flow: parseFlow(row.flow),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * POST /api/scripts
 * Body: name?, flow (JSON conversation flow)
 */
async function create(req, res) {
  try {
    await ensureScriptsTable();
    const { name, flow } = req.body || {};
    const nameVal = name != null && name !== "" ? String(name).trim() : null;
    const flowVal = flow == null ? null : typeof flow === "string" ? flow : JSON.stringify(flow);
    const [r] = await pool.query(
      "INSERT INTO scripts (name, flow) VALUES (?, ?)",
      [nameVal, flowVal]
    );
    const [rows] = await pool.query("SELECT * FROM scripts WHERE id = ?", [r.insertId]);
    res.status(201).json({ success: true, data: scriptRowToObject(rows[0]) });
  } catch (err) {
    console.error("Create script error:", err);
    res.status(500).json({ success: false, message: "Failed to create script." });
  }
}

/**
 * GET /api/scripts?page=&limit=&search=
 */
async function list(req, res) {
  try {
    await ensureScriptsTable();
    const { page = 1, limit = 10, search } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * limitNum;
    let where = "";
    const params = [];
    if (search && String(search).trim()) {
      where = "WHERE name LIKE ?";
      params.push(`%${String(search).trim()}%`);
    }
    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM scripts ${where}`, params);
    const total = countRow.total;
    const [rows] = await pool.query(
      `SELECT * FROM scripts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );
    const data = rows.map(scriptRowToObject);
    const currentPage = Math.floor(offset / limitNum) + 1;
    res.json({
      success: true,
      data,
      pagination: { page: currentPage, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (err) {
    console.error("List scripts error:", err);
    res.status(500).json({ success: false, message: "Failed to list scripts." });
  }
}

/**
 * GET /api/scripts/:id
 */
async function getById(req, res) {
  try {
    await ensureScriptsTable();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid script id." });
    const [rows] = await pool.query("SELECT * FROM scripts WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Script not found." });
    res.json({ success: true, data: scriptRowToObject(rows[0]) });
  } catch (err) {
    console.error("Get script error:", err);
    res.status(500).json({ success: false, message: "Failed to get script." });
  }
}

/**
 * PUT /api/scripts/:id
 * Body: name?, flow?
 */
async function update(req, res) {
  try {
    await ensureScriptsTable();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid script id." });
    const [rows] = await pool.query("SELECT * FROM scripts WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Script not found." });
    const current = rows[0];
    const body = req.body || {};
    const nameVal = body.name !== undefined ? (body.name != null && body.name !== "" ? String(body.name).trim() : null) : current.name;
    const flowVal = body.flow !== undefined ? (body.flow == null ? null : typeof body.flow === "string" ? body.flow : JSON.stringify(body.flow)) : current.flow;
    await pool.query("UPDATE scripts SET name = ?, flow = ? WHERE id = ?", [nameVal, flowVal, id]);
    const [updated] = await pool.query("SELECT * FROM scripts WHERE id = ?", [id]);
    res.json({ success: true, data: scriptRowToObject(updated[0]) });
  } catch (err) {
    console.error("Update script error:", err);
    res.status(500).json({ success: false, message: "Failed to update script." });
  }
}

/**
 * DELETE /api/scripts/:id
 */
async function remove(req, res) {
  try {
    await ensureScriptsTable();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid script id." });
    const [r] = await pool.query("DELETE FROM scripts WHERE id = ?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, message: "Script not found." });
    res.json({ success: true, message: "Script deleted." });
  } catch (err) {
    console.error("Delete script error:", err);
    res.status(500).json({ success: false, message: "Failed to delete script." });
  }
}

module.exports = { create, list, getById, update, remove };
