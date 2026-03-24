const pool = require("../config/db");

const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"];
const LEAD_STATUSES = ["pending", "called", "skipped"];

let campaignSchemaChecked = false;
async function ensureCampaignSchema() {
  if (campaignSchemaChecked) return;

  // campaigns table exists in schema.sql, but may be missing these fields in older DBs.
  const alters = [
    "ALTER TABLE campaigns ADD COLUMN script_id INT NULL",
    "ALTER TABLE campaigns ADD COLUMN schedule TEXT NULL",
    "ALTER TABLE campaigns ADD COLUMN timezone VARCHAR(100) NULL",
    "ALTER TABLE campaigns ADD COLUMN call_frequency INT NULL",
    "ALTER TABLE campaigns ADD COLUMN lead_list TEXT NULL",
  ];

  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      const isDuplicateColumn = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!isDuplicateColumn) throw e;
    }
  }

  // Join table to assign leads to campaigns and track per-lead progress.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS campaign_leads (
      id INT PRIMARY KEY AUTO_INCREMENT,
      campaign_id INT NOT NULL,
      lead_id INT NOT NULL,
      status ENUM('pending','called','skipped') DEFAULT 'pending',
      last_called_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_campaign_lead (campaign_id, lead_id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    )`
  );

  campaignSchemaChecked = true;
}

function toIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

async function getScriptIdByName(scriptName) {
  const scriptNameVal = toOptionalString(scriptName);
  if (!scriptNameVal) return null;
  const [rows] = await pool.query("SELECT id FROM scripts WHERE name = ? LIMIT 1", [scriptNameVal]);
  return rows.length ? rows[0].id : null;
}

function normalizeLeadList(lead_list) {
  if (lead_list == null) return [];
  if (Array.isArray(lead_list)) return lead_list.map((x) => toIntOrNull(x)).filter((x) => x != null);
  if (typeof lead_list === "string") {
    // Accept JSON string or comma-separated ids
    const raw = lead_list.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => toIntOrNull(x)).filter((x) => x != null);
    } catch (_) {
      // fallthrough
    }
    return raw.split(",").map((x) => toIntOrNull(x)).filter((x) => x != null);
  }
  return [];
}

async function setCampaignLeads(campaignId, leadIds) {
  const unique = Array.from(new Set(leadIds));

  const [existing] = await pool.query("SELECT lead_id FROM campaign_leads WHERE campaign_id = ?", [campaignId]);
  const existingSet = new Set(existing.map((r) => r.lead_id));
  const newSet = new Set(unique);

  const toAdd = unique.filter((id) => !existingSet.has(id));
  const toRemove = Array.from(existingSet).filter((id) => !newSet.has(id));

  if (toAdd.length) {
    const values = toAdd.map((leadId) => [campaignId, leadId, "pending"]);
    await pool.query("INSERT IGNORE INTO campaign_leads (campaign_id, lead_id, status) VALUES ?", [values]);
  }
  if (toRemove.length) {
    await pool.query(
      `DELETE FROM campaign_leads WHERE campaign_id = ? AND lead_id IN (${toRemove.map(() => "?").join(",")})`,
      [campaignId, ...toRemove]
    );
  }
}

async function getProgress(campaignId) {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS count
     FROM campaign_leads
     WHERE campaign_id = ?
     GROUP BY status`,
    [campaignId]
  );
  const out = { total_assigned: 0, pending: 0, called: 0, skipped: 0 };
  for (const r of rows) {
    out.total_assigned += r.count;
    if (r.status === "pending") out.pending = r.count;
    if (r.status === "called") out.called = r.count;
    if (r.status === "skipped") out.skipped = r.count;
  }
  return out;
}

function campaignRowToObject(row, progress) {
  const lead_list = row.lead_list ? (() => { try { return JSON.parse(row.lead_list); } catch { return row.lead_list; } })() : null;
  const schedule = row.schedule ? (() => { try { return JSON.parse(row.schedule); } catch { return row.schedule; } })() : null;
  return {
    id: row.id,
    name: row.name,
    script_id: row.script_id ?? null,
    script_name: row.script_name ?? null,
    schedule,
    timezone: row.timezone ?? null,
    call_frequency: row.call_frequency ?? null,
    status: row.status,
    lead_list,
    hotel_id: row.hotel_id ?? null,
    type: row.type ?? null,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    progress: progress || undefined,
  };
}

/**
 * POST /api/campaign
 * Body: name, script_id, schedule, timezone, call_frequency, status, lead_list
 */
async function create(req, res) {
  try {
    await ensureCampaignSchema();

    const {
      name,
      script_id,
      script_name,
      schedule,
      timezone,
      call_frequency,
      status = "draft",
      lead_list,
    } = req.body || {};

    const nameVal = toOptionalString(name);
    if (!nameVal) return res.status(400).json({ success: false, message: "name is required." });

    const statusVal = CAMPAIGN_STATUSES.includes(String(status)) ? String(status) : "draft";
    let scriptIdVal = script_id !== undefined ? toIntOrNull(script_id) : null;
    const callFreqVal = toIntOrNull(call_frequency);
    const tzVal = toOptionalString(timezone);

    // Allow dropdown to send script_name (readable), but store script_id (numeric).
    if (scriptIdVal == null && script_name !== undefined) {
      const resolved = await getScriptIdByName(script_name);
      if (!resolved) {
        return res.status(400).json({ success: false, message: "Selected script not found." });
      }
      scriptIdVal = resolved;
    }

    const scheduleVal =
      schedule == null ? null : typeof schedule === "string" ? (schedule.trim() || null) : JSON.stringify(schedule);

    const leadIds = normalizeLeadList(lead_list);
    const leadListVal = JSON.stringify(leadIds);

    const [r] = await pool.query(
      `INSERT INTO campaigns (name, script_id, schedule, timezone, call_frequency, status, lead_list)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nameVal, scriptIdVal, scheduleVal, tzVal, callFreqVal, statusVal, leadListVal]
    );

    if (leadIds.length) await setCampaignLeads(r.insertId, leadIds);

    const [rows] = await pool.query(
      `SELECT c.*, s.name AS script_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       WHERE c.id = ?`,
      [r.insertId]
    );
    const progress = await getProgress(r.insertId);
    res.status(201).json({ success: true, data: campaignRowToObject(rows[0], progress) });
  } catch (err) {
    console.error("Create campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign." });
  }
}

/**
 * GET /api/campaigns?page=&limit=&search=&status=
 */
async function list(req, res) {
  try {
    await ensureCampaignSchema();
    const { page = 1, limit = 10, search, status } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * limitNum;

    const where = [];
    const params = [];
    if (search && String(search).trim()) {
      where.push("c.name LIKE ?");
      params.push(`%${String(search).trim()}%`);
    }
    if (status && CAMPAIGN_STATUSES.includes(String(status))) {
      where.push("c.status = ?");
      params.push(String(status));
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM campaigns c ${whereClause}`, params);
    const total = countRow.total;
    const [rows] = await pool.query(
      `SELECT c.*, s.name AS script_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const data = await Promise.all(rows.map(async (r) => campaignRowToObject(r, await getProgress(r.id))));
    res.json({
      success: true,
      data,
      pagination: { page: Math.floor(offset / limitNum) + 1, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (err) {
    console.error("List campaigns error:", err);
    res.status(500).json({ success: false, message: "Failed to list campaigns." });
  }
}

/**
 * GET /api/campaign/:id
 */
async function getById(req, res) {
  try {
    await ensureCampaignSchema();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid campaign id." });
    const [rows] = await pool.query(
      `SELECT c.*, s.name AS script_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       WHERE c.id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Campaign not found." });
    const progress = await getProgress(id);
    res.json({ success: true, data: campaignRowToObject(rows[0], progress) });
  } catch (err) {
    console.error("Get campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to get campaign." });
  }
}

/**
 * PUT /api/campaign/:id
 * Body: name?, script_id?, schedule?, timezone?, call_frequency?, status?, lead_list?
 */
async function update(req, res) {
  try {
    await ensureCampaignSchema();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid campaign id." });

    const [rows] = await pool.query("SELECT * FROM campaigns WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Campaign not found." });
    const current = rows[0];

    const body = req.body || {};
    const nameVal = body.name !== undefined ? toOptionalString(body.name) : current.name;
    if (!nameVal) return res.status(400).json({ success: false, message: "name is required." });

    const statusVal = body.status !== undefined && CAMPAIGN_STATUSES.includes(String(body.status)) ? String(body.status) : current.status;
    let scriptIdVal = current.script_id;
    if (body.script_id !== undefined) {
      scriptIdVal = toIntOrNull(body.script_id);
    } else if (body.script_name !== undefined) {
      const resolved = await getScriptIdByName(body.script_name);
      if (!resolved) return res.status(400).json({ success: false, message: "Selected script not found." });
      scriptIdVal = resolved;
    }
    const callFreqVal = body.call_frequency !== undefined ? toIntOrNull(body.call_frequency) : current.call_frequency;
    const tzVal = body.timezone !== undefined ? toOptionalString(body.timezone) : current.timezone;
    const scheduleVal = body.schedule !== undefined
      ? (body.schedule == null ? null : (typeof body.schedule === "string" ? (body.schedule.trim() || null) : JSON.stringify(body.schedule)))
      : current.schedule;

    const leadIds = body.lead_list !== undefined ? normalizeLeadList(body.lead_list) : null;
    const leadListVal = leadIds ? JSON.stringify(leadIds) : current.lead_list;

    await pool.query(
      `UPDATE campaigns SET name = ?, script_id = ?, schedule = ?, timezone = ?, call_frequency = ?, status = ?, lead_list = ? WHERE id = ?`,
      [nameVal, scriptIdVal, scheduleVal, tzVal, callFreqVal, statusVal, leadListVal, id]
    );

    if (leadIds) await setCampaignLeads(id, leadIds);

    const [updated] = await pool.query(
      `SELECT c.*, s.name AS script_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       WHERE c.id = ?`,
      [id]
    );
    const progress = await getProgress(id);
    res.json({ success: true, data: campaignRowToObject(updated[0], progress) });
  } catch (err) {
    console.error("Update campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to update campaign." });
  }
}

/**
 * DELETE /api/campaign/:id
 */
async function remove(req, res) {
  try {
    await ensureCampaignSchema();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid campaign id." });
    const [r] = await pool.query("DELETE FROM campaigns WHERE id = ?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, message: "Campaign not found." });
    res.json({ success: true, message: "Campaign deleted." });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to delete campaign." });
  }
}

module.exports = { create, list, getById, update, remove };

