const pool = require("../config/db");
const fs = require("fs/promises");

const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"];
const LEAD_STATUSES = ["pending", "called", "skipped"];

let campaignSchemaChecked = false;
async function ensureCampaignSchema() {
  if (campaignSchemaChecked) return;

  // campaigns table exists in schema.sql, but may be missing these fields in older DBs.
  const alters = [
    "ALTER TABLE campaigns ADD COLUMN script_id INT NULL",
    "ALTER TABLE campaigns ADD COLUMN start_date DATE NULL",
    "ALTER TABLE campaigns ADD COLUMN end_date DATE NULL",
    "ALTER TABLE campaigns ADD COLUMN schedule TEXT NULL",
    "ALTER TABLE campaigns ADD COLUMN timezone VARCHAR(100) NULL",
    "ALTER TABLE campaigns ADD COLUMN call_frequency INT NULL",
    "ALTER TABLE campaigns ADD COLUMN lead_list TEXT NULL",
    "ALTER TABLE campaigns ADD COLUMN leads_csv_path TEXT NULL",
    "ALTER TABLE campaigns ADD COLUMN leads_csv_original_name VARCHAR(255) NULL",
    "ALTER TABLE campaigns ADD COLUMN voice_agent_id INT NULL",
    "ALTER TABLE campaigns ADD COLUMN created_by INT NULL",
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

function toDateOrNull(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  // Accept YYYY-MM-DD directly
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === "," && !inQuotes) || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, "_");
}

async function ensureLeadColumns() {
  // Campaign CSV import needs these columns (same idea as leadsController.ensureLeadColumns).
  const alters = [
    "ALTER TABLE leads ADD COLUMN hotel_name VARCHAR(255)",
    "ALTER TABLE leads ADD COLUMN owner_name VARCHAR(255)",
    "ALTER TABLE leads ADD COLUMN rooms INT",
    "ALTER TABLE leads ADD COLUMN location VARCHAR(255)",
    "ALTER TABLE leads ADD COLUMN agent_id INT",
    "ALTER TABLE leads ADD COLUMN created_by INT",
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      const isDuplicateColumn = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!isDuplicateColumn) throw e;
    }
  }
}

function parseCampaignLeadsCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length);

  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map(normalizeHeader);
  const rows = lines.slice(1);

  const phoneKey = header.find((h) => ["phone", "phone_number", "number", "mobile", "contact"].includes(h));
  if (!phoneKey) return [];

  const emailKey = header.find((h) => ["email", "email_id"].includes(h));
  const nameKey = header.find((h) => ["owner_name", "name", "hotel_name"].includes(h));
  const hotelKey = header.find((h) => ["hotel_name"].includes(h));
  const roomsKey = header.find((h) => ["rooms", "room_count"].includes(h));
  const locationKey = header.find((h) => ["location", "area"].includes(h));
  const statusKey = header.find((h) => ["status", "lead_status"].includes(h));
  const notesKey = header.find((h) => ["notes", "note"].includes(h));

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const values = parseCsvLine(rows[i]);
    const row = {};
    header.forEach((h, j) => {
      row[h] = values[j] != null ? String(values[j]).trim() : "";
    });

    const phone = row[phoneKey] || null;
    if (!phone) continue;

    const owner_name = nameKey ? row[nameKey] : null;
    out.push({
      owner_name: owner_name || "Unknown",
      hotel_name: hotelKey ? row[hotelKey] || null : null,
      phone: phone || null,
      email: emailKey ? row[emailKey] || null : null,
      rooms: roomsKey ? row[roomsKey] || null : null,
      location: locationKey ? row[locationKey] || null : null,
      status: statusKey ? row[statusKey] || null : null,
      notes: notesKey ? row[notesKey] || null : null,
    });
  }

  return out;
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

function toSafeLeadStatus(v) {
  const s = v ? String(v).trim().toLowerCase() : "";
  const valid = ["new", "contacted", "qualified", "converted", "lost"];
  return valid.includes(s) ? s : "new";
}

async function importLeadsFromCsvFile({ req, filePath }) {
  await ensureLeadColumns();

  const text = await fs.readFile(filePath, "utf8");
  const parsedRows = parseCampaignLeadsCsv(text);
  if (!parsedRows.length) return [];

  const createdBy = req.user?.id || null;
  const leadIds = [];

  for (const row of parsedRows) {
    const phone = row.phone ? String(row.phone).trim() : null;
    const email = row.email ? String(row.email).trim() : null;
    if (!phone && !email) continue;

    const owner_name = row.owner_name || "Unknown";
    const name = owner_name || "Unknown";
    const status = toSafeLeadStatus(row.status);
    const roomsVal = row.rooms != null && row.rooms !== "" ? parseInt(String(row.rooms), 10) : null;

    const [existing] = await pool.query(
      "SELECT id FROM leads WHERE (? IS NOT NULL AND phone = ?) OR (? IS NOT NULL AND email = ?) LIMIT 1",
      [phone, phone, email, email]
    );
    if (existing && existing.length) {
      leadIds.push(existing[0].id);
      continue;
    }

    const [r] = await pool.query(
      `INSERT INTO leads
        (name, hotel_name, owner_name, email, phone, rooms, location, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        row.hotel_name ? String(row.hotel_name).trim() : null,
        owner_name ? String(owner_name).trim() : null,
        email ? email.trim() : null,
        phone ? phone.trim() : null,
        Number.isFinite(roomsVal) ? roomsVal : null,
        row.location ? String(row.location).trim() : null,
        status,
        row.notes ? String(row.notes).trim() : null,
        createdBy,
      ]
    );
    leadIds.push(r.insertId);
  }

  return leadIds;
}

function parseContactsField(contacts) {
  if (contacts == null) return [];
  if (Array.isArray(contacts)) return contacts;
  if (typeof contacts === "string") {
    const raw = contacts.trim();
    if (!raw) return [];
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function importManualContactsToLeads(req, contacts) {
  await ensureLeadColumns();
  const createdBy = req.user?.id || null;
  const leadIds = [];
  for (const c of contacts) {
    if (!c || typeof c !== "object") continue;
    const phone = toOptionalString(c.phone ?? c.contact ?? c.number ?? c.mobile);
    const name = toOptionalString(c.name ?? c.contact_name ?? c.owner_name) || "Unknown";
    if (!phone) continue;

    const [existing] = await pool.query("SELECT id FROM leads WHERE phone = ? LIMIT 1", [phone]);
    if (existing.length) {
      leadIds.push(existing[0].id);
      continue;
    }
    const [r] = await pool.query(
      `INSERT INTO leads (name, hotel_name, owner_name, email, phone, rooms, location, status, notes, created_by)
       VALUES (?, NULL, ?, NULL, ?, NULL, NULL, 'new', NULL, ?)`,
      [name, name, phone, createdBy]
    );
    leadIds.push(r.insertId);
  }
  return leadIds;
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
    voice_agent_id: row.voice_agent_id ?? null,
    voice_agent_name: row.voice_agent_name ?? null,
    script_id: row.script_id ?? null,
    script_name: row.script_name ?? null,
    leads_csv_path: row.leads_csv_path ?? null,
    leads_csv_original_name: row.leads_csv_original_name ?? null,
    schedule,
    timezone: row.timezone ?? null,
    call_frequency: row.call_frequency ?? null,
    status: row.status,
    lead_list,
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
    const createdBy = req.user?.id || null;

    const {
      name,
      script_id,
      agent_id,
      voice_agent_id,
      script_name,
      schedule,
      start_date,
      end_date,
      timezone,
      call_frequency,
      status = "draft",
      lead_list,
      contacts,
    } = req.body || {};

    const nameVal = toOptionalString(name);
    if (!nameVal) return res.status(400).json({ success: false, message: "name is required." });

    const statusVal = CAMPAIGN_STATUSES.includes(String(status)) ? String(status) : "draft";
    let scriptIdVal = script_id !== undefined ? toIntOrNull(script_id) : null;
    let voiceAgentIdVal =
      voice_agent_id !== undefined ? toIntOrNull(voice_agent_id) : agent_id !== undefined ? toIntOrNull(agent_id) : null;
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

    const scheduleObj = schedule && typeof schedule === "object" ? schedule : null;
    const startDateVal =
      toDateOrNull(start_date) ||
      (scheduleObj ? toDateOrNull(scheduleObj.start_date || scheduleObj.startDate) : null) ||
      null;
    const endDateVal =
      toDateOrNull(end_date) ||
      (scheduleObj ? toDateOrNull(scheduleObj.end_date || scheduleObj.endDate) : null) ||
      null;

    let leadIds = normalizeLeadList(lead_list);
    const manualContacts = parseContactsField(contacts);
    if (manualContacts.length) {
      const added = await importManualContactsToLeads(req, manualContacts);
      if (added.length) leadIds = Array.from(new Set([...leadIds, ...added]));
    }

    let leadsCsvPath = null;
    let leadsCsvOriginalName = null;

    if (req.file?.path) {
      leadsCsvPath = req.file.path;
      leadsCsvOriginalName = req.file.originalname ?? null;

      const importedLeadIds = await importLeadsFromCsvFile({
        req,
        filePath: req.file.path,
      });
      if (importedLeadIds.length) {
        leadIds = Array.from(new Set([...(leadIds || []), ...importedLeadIds]));
      }
    }

    const leadListVal = JSON.stringify(Array.from(new Set(leadIds)));

    const [r] = await pool.query(
      `INSERT INTO campaigns
        (name, voice_agent_id, script_id, start_date, end_date, schedule, timezone, call_frequency, status, lead_list, leads_csv_path, leads_csv_original_name, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nameVal,
        voiceAgentIdVal,
        scriptIdVal,
        startDateVal,
        endDateVal,
        scheduleVal,
        tzVal,
        callFreqVal,
        statusVal,
        leadListVal,
        leadsCsvPath,
        leadsCsvOriginalName,
        createdBy,
      ]
    );

    if (leadIds.length) await setCampaignLeads(r.insertId, leadIds);

    const [rows] = await pool.query(
      `SELECT c.*, s.name AS script_name, va.name AS voice_agent_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       LEFT JOIN voice_agents va ON va.id = c.voice_agent_id
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
    where.push("c.created_by = ?");
    params.push(req.user.id);
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
      `SELECT c.*, s.name AS script_name, va.name AS voice_agent_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       LEFT JOIN voice_agents va ON va.id = c.voice_agent_id
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
      `SELECT c.*, s.name AS script_name, va.name AS voice_agent_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       LEFT JOIN voice_agents va ON va.id = c.voice_agent_id
       WHERE c.id = ? AND (c.created_by = ? OR c.created_by IS NULL)`,
      [id, req.user.id]
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

    const [rows] = await pool.query(
      "SELECT * FROM campaigns WHERE id = ? AND (created_by = ? OR created_by IS NULL)",
      [id, req.user.id]
    );
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
    let voiceAgentIdVal = current.voice_agent_id;
    if (body.voice_agent_id !== undefined) {
      voiceAgentIdVal = toIntOrNull(body.voice_agent_id);
    } else if (body.agent_id !== undefined) {
      voiceAgentIdVal = toIntOrNull(body.agent_id);
    }
    const callFreqVal = body.call_frequency !== undefined ? toIntOrNull(body.call_frequency) : current.call_frequency;
    const tzVal = body.timezone !== undefined ? toOptionalString(body.timezone) : current.timezone;
    const scheduleObjForDates = body.schedule && typeof body.schedule === "object" ? body.schedule : null;
    const startDateVal =
      body.start_date !== undefined ? toDateOrNull(body.start_date) : scheduleObjForDates ? toDateOrNull(scheduleObjForDates.start_date || scheduleObjForDates.startDate) : current.start_date;
    const endDateVal =
      body.end_date !== undefined ? toDateOrNull(body.end_date) : scheduleObjForDates ? toDateOrNull(scheduleObjForDates.end_date || scheduleObjForDates.endDate) : current.end_date;
    const scheduleVal = body.schedule !== undefined
      ? (body.schedule == null ? null : (typeof body.schedule === "string" ? (body.schedule.trim() || null) : JSON.stringify(body.schedule)))
      : current.schedule;

    let leadIds = body.lead_list !== undefined ? normalizeLeadList(body.lead_list) : null;
    const manualContacts = parseContactsField(body.contacts);
    if (manualContacts.length) {
      const added = await importManualContactsToLeads(req, manualContacts);
      if (added.length) {
        leadIds = Array.from(new Set([...(leadIds || []), ...added]));
      }
    }
    let leadsCsvPath = current.leads_csv_path ?? null;
    let leadsCsvOriginalName = current.leads_csv_original_name ?? null;

    if (req.file?.path) {
      leadsCsvPath = req.file.path;
      leadsCsvOriginalName = req.file.originalname ?? null;

      const importedLeadIds = await importLeadsFromCsvFile({ req, filePath: req.file.path });
      if (importedLeadIds.length) {
        leadIds = Array.from(new Set([...(leadIds || []), ...importedLeadIds]));
      }
    }

    const leadListVal = leadIds ? JSON.stringify(Array.from(new Set(leadIds))) : current.lead_list;

    await pool.query(
      `UPDATE campaigns SET
         name = ?,
         voice_agent_id = ?,
         script_id = ?,
         start_date = ?,
         end_date = ?,
         schedule = ?,
         timezone = ?,
         call_frequency = ?,
         status = ?,
         lead_list = ?,
         leads_csv_path = ?,
         leads_csv_original_name = ?,
         created_by = COALESCE(created_by, ?)
       WHERE id = ? AND (created_by = ? OR created_by IS NULL)`,
      [
        nameVal,
        voiceAgentIdVal,
        scriptIdVal,
        startDateVal,
        endDateVal,
        scheduleVal,
        tzVal,
        callFreqVal,
        statusVal,
        leadListVal,
        leadsCsvPath,
        leadsCsvOriginalName,
        req.user.id,
        id,
        req.user.id,
      ]
    );

    if (leadIds !== null) await setCampaignLeads(id, leadIds);

    const [updated] = await pool.query(
      `SELECT c.*, s.name AS script_name, va.name AS voice_agent_name
       FROM campaigns c
       LEFT JOIN scripts s ON s.id = c.script_id
       LEFT JOIN voice_agents va ON va.id = c.voice_agent_id
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
    const [r] = await pool.query(
      "DELETE FROM campaigns WHERE id = ? AND (created_by = ? OR created_by IS NULL)",
      [id, req.user.id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ success: false, message: "Campaign not found." });
    res.json({ success: true, message: "Campaign deleted." });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to delete campaign." });
  }
}

module.exports = { create, list, getById, update, remove, ensureCampaignSchema };

