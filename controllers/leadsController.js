const pool = require("../config/db");

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"];

let columnsChecked = false;
async function ensureLeadColumns() {
  if (columnsChecked) return;
  // Add columns without AFTER so it works on all MySQL versions. Ignore only "Duplicate column" errors.
  const alters = [
    "ALTER TABLE leads ADD COLUMN hotel_name VARCHAR(255)",
    "ALTER TABLE leads ADD COLUMN owner_name VARCHAR(255)",
    "ALTER TABLE leads ADD COLUMN rooms INT",
    "ALTER TABLE leads ADD COLUMN location VARCHAR(255)",
    "ALTER TABLE leads ADD COLUMN tags VARCHAR(500)",
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      const isDuplicateColumn = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!isDuplicateColumn) {
        console.error("Lead column migration failed:", sql, e.message);
        throw e;
      }
    }
  }
  columnsChecked = true;
}

function leadRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    hotel_name: row.hotel_name || null,
    owner_name: row.owner_name ?? row.name,
    phone: row.phone || null,
    email: row.email || null,
    rooms: row.rooms != null ? row.rooms : null,
    location: row.location || null,
    status: row.status || "new",
    tags: row.tags || null,
    notes: row.notes || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: row.source || null,
    hotel_id: row.hotel_id ?? null,
  };
}

/**
 * POST /api/leads
 * Body: hotel_name, owner_name, phone, email, rooms, location, status, tags, notes, source, hotel_id
 */
async function create(req, res) {
  try {
    await ensureLeadColumns();

    const {
      hotel_name,
      owner_name,
      phone,
      email,
      rooms,
      location,
      status = "new",
      tags,
      notes,
      source,
      hotel_id,
    } = req.body;
    const name = owner_name || "Unknown";
    if (!name.trim()) {
      return res.status(400).json({ success: false, message: "owner_name is required." });
    }
    const validStatus = STATUSES.includes(status) ? status : "new";
    const sourceVal = source != null && source !== "" ? String(source).trim() : null;
    const hotelIdVal = hotel_id != null && hotel_id !== "" ? parseInt(hotel_id, 10) : null;

    let r;
    try {
      [r] = await pool.query(
        `INSERT INTO leads (name, hotel_name, owner_name, email, phone, source, hotel_id, rooms, location, status, tags, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name.trim(),
          hotel_name?.trim() || null,
          owner_name?.trim() || null,
          email?.trim() || null,
          phone?.trim() || null,
          sourceVal,
          isNaN(hotelIdVal) ? null : hotelIdVal,
          rooms != null ? parseInt(rooms, 10) : null,
          location?.trim() || null,
          validStatus,
          tags?.trim() || null,
          notes?.trim() || null,
        ]
      );
    } catch (insertErr) {
      const isUnknownColumn = insertErr.code === "ER_BAD_FIELD_ERROR" || insertErr.errno === 1054;
      if (isUnknownColumn) {
        columnsChecked = false;
        const notesText = [notes, hotel_name && `Hotel: ${hotel_name}`, location && `Location: ${location}`, tags && `Tags: ${tags}`, rooms != null && rooms !== "" && `Rooms: ${rooms}`]
          .filter(Boolean)
          .join(" | ") || null;
        [r] = await pool.query(
          "INSERT INTO leads (name, email, phone, source, hotel_id, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [name.trim(), email?.trim() || null, phone?.trim() || null, sourceVal, isNaN(hotelIdVal) ? null : hotelIdVal, validStatus, notesText]
        );
      } else throw insertErr;
    }
    const [rows] = await pool.query(
      "SELECT * FROM leads WHERE id = ?",
      [r.insertId]
    );
    res.status(201).json({ success: true, data: leadRowToObject(rows[0]) });
  } catch (err) {
    console.error("Create lead error:", err);
    res.status(500).json({ success: false, message: "Failed to create lead." });
  }
}

/**
 * GET /api/leads?search=&status=&page=1&limit=10
 * search: hotel_name, owner_name, email, phone, location
 * filters: status
 * pagination: page, limit
 */
async function list(req, res) {
  try {
    const { search, status, page = 1, limit = 10 } = req.query;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(100, Math.max(1, parseInt(limit, 10)));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    let where = [];
    let params = [];

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      where.push("(l.hotel_name LIKE ? OR l.owner_name LIKE ? OR l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.location LIKE ? OR l.notes LIKE ?)");
      params.push(term, term, term, term, term, term, term);
    }
    if (status && STATUSES.includes(status)) {
      where.push("l.status = ?");
      params.push(status);
    }

    let whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
    let listParams = [...params];

    let total;
    let rows;
    try {
      const [countResult] = await pool.query(`SELECT COUNT(*) AS total FROM leads l ${whereClause}`, listParams);
      total = countResult[0].total;
      [rows] = await pool.query(`SELECT l.* FROM leads l ${whereClause} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`, [...listParams, limitNum, offset]);
    } catch (listErr) {
      if ((listErr.code === "ER_BAD_FIELD_ERROR" || listErr.errno === 1054) && search && search.trim()) {
        const term = `%${search.trim()}%`;
        where = ["(l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.notes LIKE ?)"];
        listParams = [term, term, term, term];
        if (status && STATUSES.includes(status)) {
          where.push("l.status = ?");
          listParams.push(status);
        }
        whereClause = "WHERE " + where.join(" AND ");
        const [countResult] = await pool.query(`SELECT COUNT(*) AS total FROM leads l ${whereClause}`, listParams);
        total = countResult[0].total;
        [rows] = await pool.query(`SELECT l.* FROM leads l ${whereClause} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`, [...listParams, limitNum, offset]);
      } else throw listErr;
    }

    const data = rows.map(leadRowToObject);
    res.json({
      success: true,
      data,
      pagination: { page: Math.floor(offset / limitNum) + 1, limit: limitNum, total },
    });
  } catch (err) {
    console.error("List leads error:", err);
    res.status(500).json({ success: false, message: "Failed to list leads." });
  }
}

/**
 * GET /api/leads/:id
 */
async function getById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid lead id." });
    const [rows] = await pool.query("SELECT * FROM leads WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Lead not found." });
    res.json({ success: true, data: leadRowToObject(rows[0]) });
  } catch (err) {
    console.error("Get lead error:", err);
    res.status(500).json({ success: false, message: "Failed to get lead." });
  }
}

/**
 * PUT /api/leads/:id
 * Body: hotel_name, owner_name, phone, email, rooms, location, status, tags, notes, source, hotel_id
 */
async function update(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid lead id." });
    const {
      hotel_name,
      owner_name,
      phone,
      email,
      rooms,
      location,
      status,
      tags,
      notes,
      source,
      hotel_id,
    } = req.body;

    const [rows] = await pool.query("SELECT * FROM leads WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Lead not found." });

    const name = owner_name !== undefined ? (owner_name || rows[0].name) : rows[0].name;
    const validStatus = status && STATUSES.includes(status) ? status : (rows[0].status || "new");
    const sourceVal = source !== undefined ? (source != null && source !== "" ? String(source).trim() : null) : rows[0].source;
    const hotelIdVal = hotel_id !== undefined ? (hotel_id != null && hotel_id !== "" ? parseInt(hotel_id, 10) : null) : rows[0].hotel_id;

    try {
      await pool.query(
        `UPDATE leads SET name = ?, hotel_name = ?, owner_name = ?, email = ?, phone = ?, source = ?, hotel_id = ?, rooms = ?, location = ?, status = ?, tags = ?, notes = ? WHERE id = ?`,
        [
          name.trim(),
          hotel_name !== undefined ? (hotel_name?.trim() || null) : rows[0].hotel_name,
          owner_name !== undefined ? (owner_name?.trim() || null) : rows[0].owner_name,
          email !== undefined ? (email?.trim() || null) : rows[0].email,
          phone !== undefined ? (phone?.trim() || null) : rows[0].phone,
          sourceVal,
          hotel_id !== undefined ? (isNaN(hotelIdVal) ? null : hotelIdVal) : rows[0].hotel_id,
          rooms !== undefined ? (rooms != null ? parseInt(rooms, 10) : null) : rows[0].rooms,
          location !== undefined ? (location?.trim() || null) : rows[0].location,
          validStatus,
          tags !== undefined ? (tags?.trim() || null) : rows[0].tags,
          notes !== undefined ? (notes?.trim() || null) : rows[0].notes,
          id,
        ]
      );
    } catch (updErr) {
      if (updErr.code === "ER_BAD_FIELD_ERROR" || updErr.errno === 1054) {
        const extra = [hotel_name && `Hotel: ${hotel_name}`, location && `Location: ${location}`, tags && `Tags: ${tags}`, rooms != null && rooms !== "" && `Rooms: ${rooms}`].filter(Boolean);
        const baseNotes = notes !== undefined ? (notes?.trim() || null) : (rows[0].notes || null);
        const notesWithExtras = extra.length ? (baseNotes ? `${baseNotes} | ${extra.join(" | ")}` : extra.join(" | ")) : baseNotes;
        await pool.query(
          "UPDATE leads SET name = ?, email = ?, phone = ?, source = ?, hotel_id = ?, status = ?, notes = ? WHERE id = ?",
          [name.trim(), email !== undefined ? (email?.trim() || null) : rows[0].email, phone !== undefined ? (phone?.trim() || null) : rows[0].phone, sourceVal, hotel_id !== undefined ? (isNaN(hotelIdVal) ? null : hotelIdVal) : rows[0].hotel_id, validStatus, notesWithExtras, id]
        );
      } else throw updErr;
    }
    const [updated] = await pool.query("SELECT * FROM leads WHERE id = ?", [id]);
    res.json({ success: true, data: leadRowToObject(updated[0]) });
  } catch (err) {
    console.error("Update lead error:", err);
    res.status(500).json({ success: false, message: "Failed to update lead." });
  }
}

/**
 * DELETE /api/leads/:id
 */
async function remove(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: "Invalid lead id." });
    const [r] = await pool.query("DELETE FROM leads WHERE id = ?", [id]);
    if (r.affectedRows === 0) return res.status(404).json({ success: false, message: "Lead not found." });
    res.json({ success: true, message: "Lead deleted." });
  } catch (err) {
    console.error("Delete lead error:", err);
    res.status(500).json({ success: false, message: "Failed to delete lead." });
  }
}

/**
 * POST /api/leads/import
 * multipart file field: file (CSV with header row)
 * CSV columns: hotel_name, owner_name, phone, email, rooms, location, status, tags, notes, source, hotel_id
 * Duplicate detection: by phone or email (skip or update - we skip duplicates)
 */
async function importCsv(req, res) {
  try {
    await ensureLeadColumns();

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: "No CSV file uploaded. Use form field 'file'." });
    }
    const text = req.file.buffer.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      return res.status(400).json({ success: false, message: "CSV must have header and at least one row." });
    }
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const rows = lines.slice(1);
    const inserted = [];
    const skipped = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const values = parseCsvLine(rows[i]);
      const row = {};
      header.forEach((h, j) => { row[h] = values[j] != null ? values[j].trim() : ""; });

      const owner_name = row.owner_name || row.name || "Unknown";
      const phone = row.phone || null;
      const email = row.email || null;

      if (!owner_name.trim()) {
        errors.push({ row: i + 2, reason: "Missing owner_name" });
        continue;
      }

      const [existing] = await pool.query(
        "SELECT id FROM leads WHERE (? IS NOT NULL AND phone = ?) OR (? IS NOT NULL AND email = ?)",
        [phone, phone, email, email]
      );
      if (existing.length > 0) {
        skipped.push({ row: i + 2, phone: phone || "", email: email || "" });
        continue;
      }

      try {
        const statusLower = (row.status || "").toLowerCase();
        const validStatus = STATUSES.includes(statusLower) ? statusLower : "new";
        let r;
        const sourceVal = row.source != null && row.source !== "" ? String(row.source).trim() : null;
        const hotelIdVal = row.hotel_id != null && row.hotel_id !== "" ? parseInt(row.hotel_id, 10) : null;
        try {
          [r] = await pool.query(
            `INSERT INTO leads (name, hotel_name, owner_name, email, phone, source, hotel_id, rooms, location, status, tags, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              owner_name,
              row.hotel_name || null,
              row.owner_name || null,
              email || null,
              phone || null,
              sourceVal,
              hotelIdVal != null && !isNaN(hotelIdVal) ? hotelIdVal : null,
              row.rooms != null && row.rooms !== "" ? parseInt(row.rooms, 10) : null,
              row.location || null,
              validStatus,
              row.tags || null,
              row.notes || null,
            ]
          );
        } catch (insertErr) {
          if (insertErr.code === "ER_BAD_FIELD_ERROR" || insertErr.errno === 1054) {
            const notesText = [row.notes, row.hotel_name && `Hotel: ${row.hotel_name}`, row.location && `Location: ${row.location}`, row.tags && `Tags: ${row.tags}`, row.rooms && `Rooms: ${row.rooms}`]
              .filter(Boolean)
              .join(" | ") || null;
            [r] = await pool.query(
              "INSERT INTO leads (name, email, phone, source, hotel_id, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [owner_name, email || null, phone || null, sourceVal, hotelIdVal != null && !isNaN(hotelIdVal) ? hotelIdVal : null, validStatus, notesText]
            );
          } else throw insertErr;
        }
        inserted.push({ row: i + 2, id: r.insertId });
      } catch (e) {
        errors.push({ row: i + 2, reason: e.message });
      }
    }

    res.json({
      success: true,
      data: {
        imported: inserted.length,
        skipped_duplicates: skipped.length,
        errors: errors.length,
        inserted,
        skipped,
        errors_list: errors,
      },
    });
  } catch (err) {
    console.error("Import leads error:", err);
    res.status(500).json({ success: false, message: "Failed to import CSV." });
  }
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

module.exports = { create, list, getById, update, remove, importCsv };
