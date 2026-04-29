const axios = require("axios");
const pool = require("../config/db");
const XLSX = require("xlsx");
const { ensureAgentsTable } = require("./omniAgentsController");
const { insertLeadsFromVoiceBulkUpload } = require("./leadsController");

/** Omnidim call logs: always exactly this many rows per page (query `page_size` is ignored). */
const OMNIDIM_CALL_LOGS_PAGE_SIZE = 10;

let callColumnsChecked = false;
async function ensureCallColumns() {
  if (callColumnsChecked) return;
  const alters = [
    "ALTER TABLE calls ADD COLUMN provider VARCHAR(50) NULL",
    "ALTER TABLE calls ADD COLUMN agent_id VARCHAR(100) NULL",
    "ALTER TABLE calls ADD COLUMN to_number VARCHAR(50) NULL",
    "ALTER TABLE calls ADD COLUMN from_number VARCHAR(50) NULL",
    "ALTER TABLE calls ADD COLUMN status VARCHAR(100) NULL",
    "ALTER TABLE calls ADD COLUMN raw_response TEXT NULL",
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      const isDup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!isDup) throw e;
    }
  }
  callColumnsChecked = true;
}

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function pickProviderCallId(data) {
  if (!data || typeof data !== "object") return null;
  return data.call_id || data.id || data.callId || data.session_id || data.sessionId || null;
}

function normalizeDirection(value) {
  const v = toOptionalString(value);
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower === "incoming" || lower === "inbound") return "incoming";
  if (lower === "outgoing" || lower === "outbound") return "outgoing";
  return null;
}

function withDirectionNormalized(record) {
  if (!record || typeof record !== "object") return record;
  const rawDirection =
    record.direction ??
    record.call_direction ??
    record.direction_type ??
    null;
  return normalizeCallLogPhoneFields({
    ...record,
    direction: normalizeDirection(rawDirection),
  });
}

/** Omnidim HTTP timeout (ms). Env OMNIDIM_REQUEST_TIMEOUT_MS, default 60000; clamp 5000–180000. */
function getOmniRequestTimeoutMs() {
  const n = parseInt(String(process.env.OMNIDIM_REQUEST_TIMEOUT_MS || "").trim(), 10);
  if (Number.isFinite(n) && n >= 5000 && n <= 180000) return n;
  return 60000;
}

function getOmniConfig() {
  const apiKey = toOptionalString(process.env.OMNIDIM_API_KEY);
  const baseUrl = toOptionalString(process.env.OMNIDIM_BASE_URL) || "https://backend.omnidim.io/api/v1";
  const callPath = toOptionalString(process.env.OMNIDIM_CALL_PATH) || "/calls/dispatch";
  const requestTimeoutMs = getOmniRequestTimeoutMs();
  return { apiKey, baseUrl, callPath, requestTimeoutMs };
}

async function omniRequest(method, endpointPath, { params, data } = {}) {
  const { apiKey, baseUrl, requestTimeoutMs } = getOmniConfig();
  if (!apiKey) {
    const err = new Error("Missing OMNIDIM_API_KEY in environment.");
    err.status = 500;
    throw err;
  }
  const endpoint = `${baseUrl.replace(/\/+$/, "")}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
  const resp = await axios({
    method,
    url: endpoint,
    params,
    data,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: requestTimeoutMs,
  });
  return resp.data;
}

async function loadScriptFromInput(body) {
  const inlineScript = toOptionalString(body.script || body.script_text || body.prompt);
  if (inlineScript) {
    return { script_text: inlineScript, script_name: null, script_id: null };
  }

  const scriptId = body.script_id != null && body.script_id !== "" ? parseInt(body.script_id, 10) : null;
  if (!Number.isFinite(scriptId)) return { script_text: null, script_name: null, script_id: null };

  const [rows] = await pool.query("SELECT id, name, flow FROM scripts WHERE id = ?", [scriptId]);
  if (!rows.length) return { script_text: null, script_name: null, script_id: scriptId };
  return {
    script_text: rows[0].flow != null ? String(rows[0].flow) : null,
    script_name: rows[0].name || null,
    script_id: rows[0].id,
  };
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

/** India-first E.164: 10-digit local → +91…; 91XXXXXXXXXX → +91…; other digits → +… */
function normalizePhone(v) {
  if (v == null || v === "") return null;
  let s = String(v).trim();
  if (!s) return null;
  if (/^[\d.]+e[+-]?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = Math.round(n).toString();
  }
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/[^\d]/g, "");
    return digits ? `+${digits}` : null;
  }
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return `+${digits}`;
}

const CALL_LOG_PHONE_KEYS = [
  "to_number",
  "toNumber",
  "from_number",
  "fromNumber",
  "phone_number",
  "destination",
  "customer_phone_number",
  "called_number",
];

function normalizeCallLogPhoneFields(record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  for (const k of CALL_LOG_PHONE_KEYS) {
    if (out[k] == null || out[k] === "") continue;
    const n = normalizePhone(out[k]);
    if (n) out[k] = n;
  }
  return out;
}

function dedupeContactsByPhone(contacts) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const c of contacts) {
    const phone = normalizePhone(c?.phone_number);
    if (!phone) continue;
    if (seen.has(phone)) {
      duplicates.push(phone);
      continue;
    }
    seen.add(phone);
    unique.push({ ...c, phone_number: phone });
  }
  return { unique, duplicates };
}

function extractContactsFromCsv(buffer) {
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => String(h || "").trim().toLowerCase().replace(/\s+/g, "_"));
  const phoneKey = headers.find((h) => ["phone", "phone_number", "number", "mobile", "contact"].includes(h));
  if (!phoneKey) return [];
  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => {
      row[h] = values[j] != null ? String(values[j]).trim() : "";
    });
    const phone = normalizePhone(row[phoneKey]);
    if (!phone) continue;
    contacts.push({ phone_number: phone, ...row });
  }
  return contacts;
}

function extractContactsFromExcel(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const contacts = [];
  for (const raw of rows) {
    const row = {};
    Object.keys(raw || {}).forEach((k) => {
      row[String(k).trim().toLowerCase().replace(/\s+/g, "_")] = raw[k];
    });
    const phone = normalizePhone(
      row.phone_number ?? row.phone ?? row.number ?? row.mobile ?? row.contact
    );
    if (!phone) continue;
    contacts.push({ phone_number: phone, ...row });
  }
  return contacts;
}

function extractContactsFromUpload(file) {
  const name = String(file?.originalname || "").toLowerCase();
  const mime = String(file?.mimetype || "").toLowerCase();
  const isExcel =
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    mime.includes("sheet") ||
    mime.includes("excel");
  return isExcel ? extractContactsFromExcel(file.buffer) : extractContactsFromCsv(file.buffer);
}

/** Display name for outbound dispatch (same idea as lead import). */
function pickBulkContactDisplayName(row) {
  if (!row || typeof row !== "object") return "Contact";
  const keys = [
    "owner_name",
    "name",
    "contact_name",
    "owner",
    "customer_name",
    "full_name",
    "hotel_name",
    "property",
    "hotel",
  ];
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "Contact";
}

async function createVoiceCall(req, res) {
  try {
    await ensureCallColumns();

    const { apiKey, baseUrl, callPath, requestTimeoutMs } = getOmniConfig();
    const defaultAgentId = toOptionalString(process.env.OMNIDIM_AGENT_ID);
    const defaultFromNumber = toOptionalString(process.env.OMNIDIM_PHONE_NUMBER);

    if (!apiKey) {
      return res.status(500).json({ success: false, message: "Missing OMNIDIM_API_KEY in environment." });
    }

    const body = req.body || {};
    const phoneRaw = toOptionalString(body.phone || body.to || body.phone_number || body.to_number);
    if (!phoneRaw) return res.status(400).json({ success: false, message: "phone is required." });
    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      return res.status(400).json({ success: false, message: "Invalid phone number. Use 10-digit India or +91… E.164." });
    }

    const agentId = toOptionalString(body.agent_id) || defaultAgentId;
    if (!agentId) {
      return res.status(400).json({ success: false, message: "agent_id is required (or set OMNIDIM_AGENT_ID)." });
    }

    const fromNumber = toOptionalString(body.from_number) || defaultFromNumber;
    const fromNumberId = body.from_number_id != null && body.from_number_id !== "" ? parseInt(body.from_number_id, 10) : null;
    const leadId = body.lead_id != null && body.lead_id !== "" ? parseInt(body.lead_id, 10) : null;
    const campaignId = body.campaign_id != null && body.campaign_id !== "" ? parseInt(body.campaign_id, 10) : null;
    const title = toOptionalString(body.title);
    const date = toOptionalString(body.date);
    const time = toOptionalString(body.time);

    const payload = {
      agent_id: Number.isFinite(parseInt(agentId, 10)) ? parseInt(agentId, 10) : agentId,
      to_number: phone,
      ...(Number.isFinite(fromNumberId) ? { from_number_id: fromNumberId } : {}),
      call_context: {
        user_id: req.user?.id || null,
        lead_id: Number.isFinite(leadId) ? leadId : null,
        campaign_id: Number.isFinite(campaignId) ? campaignId : null,
        title: title || null,
        date: date || null,
        time: time || null,
      },
      // Compatibility keys
      to: phone,
      phone_number: phone,
      ...(fromNumber ? { from: fromNumber, from_number: fromNumber } : {}),
    };

    const endpoint = `${baseUrl.replace(/\/+$/, "")}${callPath.startsWith("/") ? callPath : `/${callPath}`}`;
    const omni = await axios.post(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      timeout: requestTimeoutMs,
    });

    const providerData = omni.data || {};
    const providerStatus = toOptionalString(providerData.status) || "created";

    const [r] = await pool.query(
      `INSERT INTO calls
      (lead_id, campaign_id, outcome, provider, agent_id, to_number, from_number, status, raw_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number.isFinite(leadId) ? leadId : null,
        Number.isFinite(campaignId) ? campaignId : null,
        providerStatus,
        "omnidimension",
        String(agentId),
        phone,
        fromNumber,
        providerStatus,
        JSON.stringify(providerData),
      ]
    );

    const [rows] = await pool.query("SELECT * FROM calls WHERE id = ?", [r.insertId]);
    res.status(201).json({ success: true, message: "Voice call created.", data: { call: rows[0], provider_response: providerData } });
  } catch (err) {
    console.error("Create OmniDimension call error:", err?.response?.data || err);
    res.status(500).json({
      success: false,
      message: "Failed to create voice call.",
      details: err?.response?.data || err?.message || null,
    });
  }
}

/**
 * POST /api/voice/call/script
 * Body: { phone, script? | script_id?, agent_id?, from_number_id? }
 */
async function createVoiceCallWithScript(req, res) {
  try {
    await ensureCallColumns();

    const { apiKey, baseUrl, callPath, requestTimeoutMs } = getOmniConfig();
    const defaultAgentId = toOptionalString(process.env.OMNIDIM_AGENT_ID);
    const defaultFromNumber = toOptionalString(process.env.OMNIDIM_PHONE_NUMBER);
    if (!apiKey) return res.status(500).json({ success: false, message: "Missing OMNIDIM_API_KEY in environment." });

    const body = req.body || {};
    const phoneRaw = toOptionalString(body.phone || body.to_number || body.to || body.phone_number);
    if (!phoneRaw) return res.status(400).json({ success: false, message: "phone is required." });
    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      return res.status(400).json({ success: false, message: "Invalid phone number. Use 10-digit India or +91… E.164." });
    }

    const agentId = toOptionalString(body.agent_id) || defaultAgentId;
    if (!agentId) return res.status(400).json({ success: false, message: "agent_id is required (or set OMNIDIM_AGENT_ID)." });

    const scriptCtx = await loadScriptFromInput(body);
    if (!scriptCtx.script_text) {
      return res.status(400).json({ success: false, message: "script or valid script_id is required." });
    }

    const fromRaw = toOptionalString(body.from_number) || defaultFromNumber;
    const fromNumber = fromRaw ? normalizePhone(fromRaw) || fromRaw : null;
    const fromNumberId = body.from_number_id != null && body.from_number_id !== "" ? parseInt(body.from_number_id, 10) : null;
    const endpoint = `${baseUrl.replace(/\/+$/, "")}${callPath.startsWith("/") ? callPath : `/${callPath}`}`;

    const payload = {
      agent_id: Number.isFinite(parseInt(agentId, 10)) ? parseInt(agentId, 10) : agentId,
      to_number: phone,
      ...(Number.isFinite(fromNumberId) ? { from_number_id: fromNumberId } : {}),
      call_context: {
        user_id: req.user?.id || null,
        script_text: scriptCtx.script_text,
        script_name: scriptCtx.script_name,
        script_id: scriptCtx.script_id,
      },
      to: phone,
      phone_number: phone,
      ...(fromNumber ? { from: fromNumber, from_number: fromNumber } : {}),
    };

    const omni = await axios.post(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      timeout: requestTimeoutMs,
    });

    const providerData = omni.data || {};
    const providerStatus = toOptionalString(providerData.status) || "created";
    const [r] = await pool.query(
      `INSERT INTO calls
      (lead_id, campaign_id, outcome, provider, agent_id, to_number, from_number, status, raw_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        null,
        null,
        providerStatus,
        "omnidimension",
        String(agentId),
        phone,
        fromNumber,
        providerStatus,
        JSON.stringify(providerData),
      ]
    );

    const [rows] = await pool.query("SELECT * FROM calls WHERE id = ?", [r.insertId]);
    res.status(201).json({ success: true, message: "Voice call created with script.", data: { call: rows[0], provider_response: providerData } });
  } catch (err) {
    console.error("Create OmniDimension call with script error:", err?.response?.data || err);
    res.status(500).json({
      success: false,
      message: "Failed to create voice call.",
      details: err?.response?.data || err?.message || null,
    });
  }
}

function flattenOmniCallLogsRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.data)) return raw.data;
  return [];
}

function wantsFetchAllPages(req) {
  const v = req.query.fetch_all ?? req.query.all_pages;
  if (v == null || v === "") return false;
  const s = String(v).toLowerCase();
  return v === "1" || s === "true" || s === "yes" || s === "all";
}

function localCallLogsFallbackEnabled() {
  const v = String(process.env.OMNIDIM_CALL_LOGS_FALLBACK_LOCAL ?? "1").toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

/** True when we should serve MySQL `calls` rows instead of hiding Omnidim transport/upstream failures. */
function isOmniCallLogsFallbackWorthy(err) {
  if (!err) return false;
  const st = err.response?.status;
  if (st === 401 || st === 403 || st === 404) return false;
  if (st >= 500) return true;
  if (!err.response) return true;
  const c = err.code;
  if (["ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ECONNABORTED"].includes(c)) return true;
  if (String(err.message || "").toLowerCase().includes("timeout")) return true;
  return false;
}

function localScopeForVoiceCallLogs(req) {
  const role = String(req.user?.role || "viewer");
  if (role === "viewer") return { kind: "none" };
  if (role === "admin") return { kind: "all" };
  return { kind: "lead_agent", userId: req.user.id };
}

function localCallRowToOmniShape(row) {
  const name =
    row.lead_display_name != null && String(row.lead_display_name).trim() !== ""
      ? String(row.lead_display_name).trim()
      : null;
  const phone = row.lead_phone || row.to_number || null;
  const rawAgent = row.agent_id != null ? String(row.agent_id).trim() : "";
  const agentNum = rawAgent !== "" && Number.isFinite(Number(rawAgent)) ? Number(rawAgent) : row.agent_id;
  return withDirectionNormalized(
    normalizeCallLogPhoneFields({
      id: row.id,
      local_call_id: row.id,
      source: "local_db",
      to_number: row.to_number,
      from_number: row.from_number,
      status: row.status,
      outcome: row.outcome,
      provider: row.provider,
      created_at: row.created_at,
      lead_id: row.lead_id,
      campaign_id: row.campaign_id,
      agent_id: agentNum,
      phone_number: phone,
      customer_name: name,
      name,
    })
  );
}

/**
 * @param {object} scope - { kind:'all' } | { kind:'none' } | { kind:'lead_agent', userId } | { kind:'call_agent_omni', omnidimAgentId }
 */
async function selectLocalCallLogsForScope(scope, params, limit, offset) {
  if (scope.kind === "none") return [];
  await ensureCallColumns();
  const parts = [];
  const args = [];

  if (scope.kind === "lead_agent") {
    parts.push("l.agent_id = ?");
    args.push(scope.userId);
  } else if (scope.kind === "call_agent_omni") {
    const aid = String(scope.omnidimAgentId);
    parts.push("TRIM(COALESCE(c.agent_id, '')) = TRIM(?)");
    args.push(aid);
  }

  if (Number.isFinite(params.agent_id) && params.agent_id > 0 && scope.kind !== "call_agent_omni") {
    parts.push("TRIM(COALESCE(c.agent_id, '')) = TRIM(?)");
    args.push(String(params.agent_id));
  }

  if (params.call_status) {
    const cs = String(params.call_status).trim();
    parts.push("(c.status = ? OR c.outcome = ?)");
    args.push(cs, cs);
  }

  const joinType = scope.kind === "lead_agent" ? "INNER JOIN" : "LEFT JOIN";
  const whereSql = parts.length ? parts.join(" AND ") : "1=1";

  const sql = `
    SELECT c.id, c.lead_id, c.campaign_id, c.outcome, c.provider, c.agent_id, c.to_number, c.from_number, c.status,
      c.created_at,
      COALESCE(NULLIF(TRIM(l.hotel_name), ''), NULLIF(TRIM(l.owner_name), ''), l.name) AS lead_display_name,
      l.phone AS lead_phone
    FROM calls c
    ${joinType} leads l ON l.id = c.lead_id
    WHERE ${whereSql}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `;
  args.push(limit, offset);
  const [rows] = await pool.query(sql, args);
  return (rows || []).map(localCallRowToOmniShape);
}

/**
 * Walks Omnidim page=1,2,3… until a page returns fewer than page_size rows (or max pages).
 * Fetches in chunks of OMNIDIM_CALL_LOGS_PAGE_SIZE (10) per Omnidim request.
 * @param {object|null} localScope - see selectLocalCallLogsForScope; if set, used when Omnidim fails.
 */
async function respondWithOmniCallLogsAllPages(res, baseParams, localScope = null) {
  try {
    const pageSize = OMNIDIM_CALL_LOGS_PAGE_SIZE;
    const maxPages = Math.min(
      500,
      Math.max(1, parseInt(String(process.env.OMNIDIM_CALL_LOGS_MAX_PAGES || "100"), 10) || 100)
    );

    const merged = [];
    let pagesFetched = 0;
    let lastPageRows = 0;

    for (let page = 1; page <= maxPages; page++) {
      const params = { ...baseParams, page, page_size: pageSize };
      const raw = await omniRequest("GET", "/calls/logs", { params });
      const rows = flattenOmniCallLogsRows(raw);
      lastPageRows = rows.length;
      merged.push(...rows.map(withDirectionNormalized));
      pagesFetched += 1;
      if (rows.length < pageSize) break;
    }

    const mayHaveMore = pagesFetched >= maxPages && lastPageRows === pageSize;

    res.json({
      success: true,
      data: merged,
      pagination: {
        mode: "fetch_all",
        page_size: pageSize,
        pages_fetched: pagesFetched,
        total: merged.length,
        may_have_more: mayHaveMore,
      },
      source: "omnidim",
    });
  } catch (err) {
    console.error("Get Omni call logs (fetch_all) error:", err?.response?.data || err);
    const maxLocal = Math.min(
      5000,
      Math.max(50, parseInt(String(process.env.OMNIDIM_CALL_LOGS_LOCAL_MAX || "2000"), 10) || 2000)
    );
    if (
      localCallLogsFallbackEnabled() &&
      localScope &&
      isOmniCallLogsFallbackWorthy(err)
    ) {
      try {
        const items = await selectLocalCallLogsForScope(localScope, baseParams, maxLocal, 0);
        return res.json({
          success: true,
          data: items,
          pagination: {
            mode: "fetch_all",
            page_size: items.length,
            pages_fetched: 1,
            total: items.length,
            may_have_more: items.length >= maxLocal,
            local_cap: maxLocal,
          },
          source: "local_db",
          degraded: true,
          omnidim_error: err.message || err.code || "upstream_error",
          note: "Omnidim unreachable; merged list is from this app’s `calls` table (capped).",
        });
      } catch (dbErr) {
        console.error("Local call logs fallback (fetch_all) failed:", dbErr);
      }
    }
    const status = err.status || err?.response?.status || 500;
    res.status(status).json({
      success: false,
      message: "Failed to fetch Omni call logs.",
      details: err?.response?.data || err?.message || null,
    });
  }
}

/**
 * GET /api/voice/calls
 * Query: page (default 1), agent_id, call_status, bulk_call_id. **page_size is fixed at 10** (ignored if sent).
 *        fetch_all=1 | all_pages=1 — server follows every page and merges (see pagination.mode).
 * @param {object|null} localScope - when Omnidim fails (ETIMEDOUT, etc.), serve rows from `calls` (see selectLocalCallLogsForScope).
 */
async function respondWithOmniCallLogs(res, params, localScope = null) {
  const page = params.page ?? 1;
  const pageSize = OMNIDIM_CALL_LOGS_PAGE_SIZE;
  const pageMeta = (itemCount) => ({
    page,
    page_size: pageSize,
    has_next_page: itemCount === pageSize,
    has_prev_page: page > 1,
  });

  try {
    const data = await omniRequest("GET", "/calls/logs", { params });

    if (Array.isArray(data)) {
      const items = data.map(withDirectionNormalized);
      return res.json({
        success: true,
        data: items,
        pagination: pageMeta(items.length),
        source: "omnidim",
      });
    }
    if (Array.isArray(data?.data)) {
      const items = data.data.map(withDirectionNormalized);
      return res.json({
        success: true,
        data: {
          ...data,
          data: items,
        },
        pagination: pageMeta(items.length),
        source: "omnidim",
      });
    }
    res.json({
      success: true,
      data: withDirectionNormalized(data),
      pagination: {
        page,
        page_size: pageSize,
        has_next_page: false,
        has_prev_page: page > 1,
      },
      source: "omnidim",
    });
  } catch (err) {
    console.error("Get Omni call logs error:", err?.response?.data || err);
    if (
      localCallLogsFallbackEnabled() &&
      localScope &&
      isOmniCallLogsFallbackWorthy(err)
    ) {
      try {
        if (localScope.kind === "none") {
          return res.json({
            success: true,
            data: [],
            pagination: pageMeta(0),
            source: "local_db",
            degraded: true,
            omnidim_error: err.message || err.code || "upstream_error",
            note: "Omnidim unreachable; viewer has no local call scope.",
          });
        }
        const offset = (page - 1) * pageSize;
        const items = await selectLocalCallLogsForScope(localScope, params, pageSize, offset);
        return res.json({
          success: true,
          data: items,
          pagination: pageMeta(items.length),
          source: "local_db",
          degraded: true,
          omnidim_error: err.message || err.code || "upstream_error",
          note: "Omnidim is unreachable or errored; showing calls stored in this application.",
        });
      } catch (dbErr) {
        console.error("Local call logs fallback failed:", dbErr);
      }
    }
    const status = err.status || err?.response?.status || 500;
    res.status(status).json({
      success: false,
      message: "Failed to fetch Omni call logs.",
      details: err?.response?.data || err?.message || null,
    });
  }
}

function buildOmniCallLogsQueryParams(req) {
  const params = {};
  const p = req.query.page != null && req.query.page !== "" ? parseInt(req.query.page, 10) : NaN;
  params.page = Number.isFinite(p) && p >= 1 ? p : 1;
  params.page_size = OMNIDIM_CALL_LOGS_PAGE_SIZE;
  if (req.query.agent_id != null && req.query.agent_id !== "") params.agent_id = parseInt(req.query.agent_id, 10);
  if (req.query.call_status) params.call_status = String(req.query.call_status).trim();
  if (req.query.bulk_call_id != null && req.query.bulk_call_id !== "") params.bulk_call_id = parseInt(req.query.bulk_call_id, 10);
  return params;
}

/** Rows from voice_agents with Omnidim external_id; exact name match first, else case-insensitive substring. */
async function findVoiceAgentsByNameForFilter(name) {
  await ensureAgentsTable();
  const [exact] = await pool.query(
    `SELECT id, name, external_id FROM voice_agents
     WHERE external_id IS NOT NULL AND TRIM(COALESCE(external_id, '')) != ''
       AND LOWER(TRIM(name)) = LOWER(?)`,
    [name]
  );
  if (exact.length) return exact;
  const [partial] = await pool.query(
    `SELECT id, name, external_id FROM voice_agents
     WHERE external_id IS NOT NULL AND TRIM(COALESCE(external_id, '')) != ''
       AND LOWER(name) LIKE LOWER(CONCAT('%', ?, '%'))`,
    [name]
  );
  return partial;
}

async function getOmniCallLogs(req, res) {
  const params = buildOmniCallLogsQueryParams(req);
  const localScope = localScopeForVoiceCallLogs(req);
  if (wantsFetchAllPages(req)) {
    return respondWithOmniCallLogsAllPages(res, params, localScope);
  }
  return respondWithOmniCallLogs(res, params, localScope);
}

/**
 * GET /api/voice/admin/calls (admin only)
 * Same Omnidim payload as GET /api/voice/calls when unfiltered.
 * Query: page, call_status, bulk_call_id, fetch_all=1.
 * Filter by voice agent (preferred when names collide):
 *   - voice_agent_id | local_agent_id = voice_agents.id (our DB) → resolves external_id for Omnidim.
 *   - agent_id = Omnidim dashboard agent id (unchanged).
 *   - agent_name = legacy name match on voice_agents (ambiguous if duplicate names).
 * Priority: voice_agent_id > agent_id from query > agent_name.
 */
async function getAdminOmniCallLogs(req, res) {
  try {
    const params = buildOmniCallLogsQueryParams(req);

    const localRaw = req.query.voice_agent_id ?? req.query.local_agent_id;
    const localVoiceAgentId =
      localRaw != null && String(localRaw).trim() !== ""
        ? parseInt(String(localRaw).trim(), 10)
        : NaN;

    if (Number.isFinite(localVoiceAgentId) && localVoiceAgentId > 0) {
      await ensureAgentsTable();
      const [vaRows] = await pool.query(
        "SELECT id, name, external_id FROM voice_agents WHERE id = ?",
        [localVoiceAgentId]
      );
      if (!vaRows.length) {
        return res.status(404).json({
          success: false,
          message:
            "voice_agent_id not found. Use voice_agents.id from GET /api/calls/outbound/agents or /agents/all.",
        });
      }
      const omniId = parseInt(String(vaRows[0].external_id).trim(), 10);
      if (!Number.isFinite(omniId) || omniId <= 0) {
        return res.status(400).json({
          success: false,
          message: "This voice agent has no valid Omnidim external_id.",
          matched: {
            id: vaRows[0].id,
            name: vaRows[0].name,
            external_id: vaRows[0].external_id != null ? String(vaRows[0].external_id) : null,
          },
        });
      }
      params.agent_id = omniId;
    } else {
      const hasNumericAgentId = Number.isFinite(params.agent_id) && params.agent_id > 0;
      const agentName = toOptionalString(req.query.agent_name);

      if (!hasNumericAgentId && agentName) {
        const rows = await findVoiceAgentsByNameForFilter(agentName);
        if (rows.length > 1) {
          return res.status(400).json({
            success: false,
            message:
              "Multiple voice agents match this name. Use voice_agent_id (voice_agents.id), agent_id (Omnidim), or a more specific agent_name.",
            matches: rows.map((r) => ({
              id: r.id,
              name: r.name,
              external_id: r.external_id != null ? String(r.external_id) : null,
            })),
          });
        }
        if (rows.length === 0) {
          const page = params.page ?? 1;
          return res.json({
            success: true,
            data: [],
            pagination: {
              page,
              page_size: OMNIDIM_CALL_LOGS_PAGE_SIZE,
              has_next_page: false,
              has_prev_page: page > 1,
            },
            filter: {
              agent_name: agentName,
              resolved_agent_id: null,
              note: "No voice_agents row matched this name (needs a synced agent with external_id).",
            },
          });
        }
        const omniId = parseInt(String(rows[0].external_id).trim(), 10);
        if (!Number.isFinite(omniId) || omniId <= 0) {
          return res.status(400).json({
            success: false,
            message: "Matched agent has no valid Omnidim external_id.",
            matched: {
              id: rows[0].id,
              name: rows[0].name,
              external_id: rows[0].external_id != null ? String(rows[0].external_id) : null,
            },
          });
        }
        params.agent_id = omniId;
      }
    }

    const adminLocalScope = { kind: "all" };
    if (wantsFetchAllPages(req)) {
      return respondWithOmniCallLogsAllPages(res, params, adminLocalScope);
    }
    return respondWithOmniCallLogs(res, params, adminLocalScope);
  } catch (err) {
    console.error("getAdminOmniCallLogs error:", err);
    res.status(500).json({ success: false, message: "Failed to load admin call logs." });
  }
}

/**
 * GET /api/voice/agents/:agent_id/calls
 * **agent_id** = Omnidim agent id. **10** call logs per page; use `page=2`, `page=3`, … for more. `fetch_all=1` merges all pages.
 */
async function getCallLogsForAgent(req, res) {
  const agentId = parseInt(req.params.agent_id, 10);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    return res.status(400).json({
      success: false,
      message: "agent_id must be a positive number (Omnidim / dashboard agent id).",
    });
  }
  const params = buildOmniCallLogsQueryParams(req);
  params.agent_id = agentId;
  const localScope = { kind: "call_agent_omni", omnidimAgentId: agentId };
  if (wantsFetchAllPages(req)) {
    return respondWithOmniCallLogsAllPages(res, params, localScope);
  }
  return respondWithOmniCallLogs(res, params, localScope);
}

/**
 * GET /api/voice/calls/:call_log_id
 * Fetches full call details directly from OmniDimension.
 */
async function getOmniCallLogById(req, res) {
  try {
    const callLogId = toOptionalString(req.params.call_log_id);
    if (!callLogId) return res.status(400).json({ success: false, message: "call_log_id is required." });

    const data = await omniRequest("GET", `/calls/logs/${encodeURIComponent(callLogId)}`);
    if (data && typeof data === "object" && data.data && typeof data.data === "object") {
      return res.json({ success: true, data: { ...data, data: withDirectionNormalized(data.data) } });
    }
    res.json({ success: true, data: withDirectionNormalized(data) });
  } catch (err) {
    console.error("Get Omni call log detail error:", err?.response?.data || err);
    const status = err.status || err?.response?.status || 500;
    res.status(status).json({
      success: false,
      message: "Failed to fetch Omni call details.",
      details: err?.response?.data || err?.message || null,
    });
  }
}

/**
 * POST /api/voice/bulk-call/upload
 * Upload CSV/XLS/XLSX and call unique phone numbers.
 *
 * Default dial_mode is **dispatch**: same per-number flow as POST /api/calls/outbound/csv (dispatchOutboundCallCore).
 * No phone_number_id required for that path — uses OMNIDIM_FROM_NUMBER_ID / OMNIDIM_PHONE_NUMBER_ID like single outbound.
 *
 * Set form field **use_omni_bulk=true** to use Omnidim POST /calls/bulk_call/create instead (requires phone_number_id;
 * Twilio line must have an assistant assigned in Omnidim or bulk may error).
 */
async function createBulkCallFromUpload(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: "Upload file is required (field name: file)." });
    }

    const body = req.body || {};
    const useOmniBulk =
      body.use_omni_bulk === true || body.use_omni_bulk === "true" || body.use_omni_bulk === "1";

    const contactsRaw = extractContactsFromUpload(req.file);
    const { unique: contacts, duplicates } = dedupeContactsByPhone(contactsRaw);

    if (!contacts.length) {
      return res.status(400).json({
        success: false,
        message:
          "No valid phone numbers found in file. Ensure the file is not empty, has a header row, a phone column (phone / phone_number / mobile), and at least one data row with real CSV content (copy-pasted curls often omit file bytes).",
      });
    }

    const maxRows = Math.min(500, Math.max(1, parseInt(process.env.OUTBOUND_CSV_MAX_ROWS || "200", 10) || 200));
    if (contacts.length > maxRows) {
      return res.status(400).json({
        success: false,
        message: `Too many numbers after dedupe (max ${maxRows}). Split the file or raise OUTBOUND_CSV_MAX_ROWS.`,
      });
    }

    const rawBulkVoice = body.voice_agent_id ?? body.agent_id;
    const voiceAgentDbIdParsed =
      rawBulkVoice != null && rawBulkVoice !== "" ? parseInt(String(rawBulkVoice), 10) : NaN;
    if (!Number.isFinite(voiceAgentDbIdParsed) || voiceAgentDbIdParsed <= 0) {
      return res.status(400).json({
        success: false,
        message: "Outbound agent is required: send voice_agent_id or agent_id (voice_agents.id from GET /api/calls/outbound/agents).",
      });
    }

    await ensureAgentsTable();
    const outboundCalls = require("./outboundCallsController");
    const agentCheck = await outboundCalls.assertSelectableVoiceAgent(
      req.user.id,
      voiceAgentDbIdParsed,
      req.user.role
    );
    if (!agentCheck.ok) {
      return res.status(403).json({ success: false, message: agentCheck.message });
    }
    const omniAgentIdForBulk = outboundCalls.resolveOmniAgentIdForPayload(agentCheck.row);
    if (omniAgentIdForBulk == null) {
      return res.status(400).json({
        success: false,
        message: "This outbound agent is not linked to Omnidim (missing external_id).",
      });
    }

    const leadsImport = await insertLeadsFromVoiceBulkUpload(contacts, req.user, {
      voiceAgentDbId: voiceAgentDbIdParsed,
    });

    if (!useOmniBulk) {
      await outboundCalls.ensureOutboundCallRequestsTable();
      const delayMs = Math.max(0, parseInt(process.env.OUTBOUND_CSV_DELAY_MS || "600", 10) || 600);
      const batchId = `voice_bulk_${Date.now()}_${req.user.id}`;
      const results = [];

      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        const contactName = pickBulkContactDisplayName(c);
        const result = await outboundCalls.dispatchOutboundCallCore({
          initiatorUserId: req.user.id,
          initiatorRole: req.user.role,
          contactName,
          phone: c.phone_number,
          voiceAgentId: voiceAgentDbIdParsed,
          importMeta: {
            source: "voice_bulk_upload",
            batch_id: batchId,
            index: i,
            campaign_name: toOptionalString(body.name) || null,
            original_filename: req.file.originalname || null,
          },
          fromNumberEnvFallback: true,
        });
        results.push({
          index: i,
          phone: c.phone_number,
          ok: result.ok,
          message: result.message,
          request_id: result.requestId,
        });
        if (i < contacts.length - 1 && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      const anyOk = results.some((x) => x.ok);
      return res.status(201).json({
        success: anyOk,
        message: anyOk
          ? "Bulk upload processed: leads saved and per-number calls dispatched."
          : "Leads import finished but no calls were sent successfully (see dial_results).",
        data: {
          dial_mode: "dispatch",
          total_rows: contactsRaw.length,
          total_unique_numbers: contacts.length,
          skipped_duplicates: duplicates.length,
          duplicate_numbers: [...new Set(duplicates)],
          leads_imported: leadsImport.inserted,
          leads_skipped_duplicates: leadsImport.skipped_duplicates,
          leads_import_errors: leadsImport.errors,
          dial_attempts: results.length,
          dial_results: results,
        },
      });
    }

    let phoneNumberId =
      body.phone_number_id != null && body.phone_number_id !== ""
        ? parseInt(body.phone_number_id, 10)
        : null;

    if (!Number.isFinite(phoneNumberId)) {
      const envId = process.env.OMNIDIM_PHONE_NUMBER_ID != null ? parseInt(process.env.OMNIDIM_PHONE_NUMBER_ID, 10) : null;
      if (Number.isFinite(envId)) phoneNumberId = envId;
    }

    if (!Number.isFinite(phoneNumberId)) {
      return res.status(400).json({
        success: false,
        message:
          "phone_number_id is required when use_omni_bulk=true (or set OMNIDIM_PHONE_NUMBER_ID in .env). Omit use_omni_bulk to use per-number dispatch (same as /api/calls/outbound/csv) without phone_number_id.",
      });
    }

    const payload = {
      name: toOptionalString(body.name) || `Bulk Call ${new Date().toISOString()}`,
      contact_list: contacts,
      phone_number_id: phoneNumberId,
      agent_id:
        typeof omniAgentIdForBulk === "number"
          ? omniAgentIdForBulk
          : Number.isFinite(parseInt(String(omniAgentIdForBulk), 10))
            ? parseInt(String(omniAgentIdForBulk), 10)
            : omniAgentIdForBulk,
      is_scheduled: body.is_scheduled === true || body.is_scheduled === "true",
      timezone: toOptionalString(body.timezone) || "UTC",
      enabled_reschedule_call: body.enabled_reschedule_call === true || body.enabled_reschedule_call === "true",
      retry_config: { auto_retry: false, auto_retry_schedule: "next_day", retry_limit: 1 },
    };

    if (payload.is_scheduled) {
      payload.scheduled_datetime = toOptionalString(body.scheduled_datetime);
      if (!payload.scheduled_datetime) {
        return res.status(400).json({ success: false, message: "scheduled_datetime is required when is_scheduled=true." });
      }
    }

    if (body.retry_config != null && body.retry_config !== "") {
      try {
        const parsed = typeof body.retry_config === "string" ? JSON.parse(body.retry_config) : body.retry_config;
        if (parsed && typeof parsed === "object") {
          payload.retry_config = {
            auto_retry: parsed.auto_retry === true || parsed.auto_retry === "true",
            auto_retry_schedule: parsed.auto_retry_schedule || "next_day",
            retry_limit: Number.isFinite(parseInt(parsed.retry_limit, 10)) ? parseInt(parsed.retry_limit, 10) : 1,
            ...(Number.isFinite(parseInt(parsed.retry_schedule_days, 10)) ? { retry_schedule_days: parseInt(parsed.retry_schedule_days, 10) } : {}),
            ...(Number.isFinite(parseInt(parsed.retry_schedule_hours, 10)) ? { retry_schedule_hours: parseInt(parsed.retry_schedule_hours, 10) } : {}),
          };
        }
      } catch {
        return res.status(400).json({ success: false, message: "retry_config must be valid JSON." });
      }
    }

    const provider = await omniRequest("POST", "/calls/bulk_call/create", { data: payload });

    return res.status(201).json({
      success: true,
      message: "Bulk call created (Omnidim bulk API).",
      data: {
        dial_mode: "omni_bulk",
        total_rows: contactsRaw.length,
        total_unique_numbers: contacts.length,
        skipped_duplicates: duplicates.length,
        duplicate_numbers: [...new Set(duplicates)],
        phone_number_id: phoneNumberId,
        leads_imported: leadsImport.inserted,
        leads_skipped_duplicates: leadsImport.skipped_duplicates,
        leads_import_errors: leadsImport.errors,
        provider_response: provider,
      },
    });
  } catch (err) {
    console.error("Bulk call upload error:", err?.response?.data || err);
    const status = err.status || err?.response?.status || 500;
    return res.status(status).json({
      success: false,
      message: "Failed to create bulk call from uploaded file.",
      details: err?.response?.data || err?.message || null,
    });
  }
}

function flattenOmnidimCallLogsList(data) {
  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  if (data?.results && Array.isArray(data.results)) return data.results;
  return [];
}

function parseIntegrationsSafe(raw) {
  if (raw == null || raw === "") return null;
  try {
    return typeof raw === "object" ? raw : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * GET /api/voice/admin/agents-call-logs (admin only)
 * For each local voice_agent row: who created it (`created_by_admin`) + recent Omnidim call logs for that agent’s `external_id`.
 *
 * Query: agents_page, agents_limit, call_status,
 *        created_by (user id = admin who created the agent), voice_agent_id (single agent).
 * Omnidim call logs per agent: **10 rows** (fixed; `calls_per_agent` / `page_size` query ignored).
 */
async function listAgentsCallLogsByCreator(req, res) {
  try {
    await ensureAgentsTable();

    const agentsPage = Math.max(1, parseInt(req.query.agents_page, 10) || 1);
    const agentsLimit = Math.min(30, Math.max(1, parseInt(req.query.agents_limit, 10) || 10));
    const agentsOffset = (agentsPage - 1) * agentsLimit;

    const callsPageSize = OMNIDIM_CALL_LOGS_PAGE_SIZE;

    const createdByFilter =
      req.query.created_by != null && req.query.created_by !== ""
        ? parseInt(req.query.created_by, 10)
        : NaN;
    const voiceAgentIdFilter =
      req.query.voice_agent_id != null && req.query.voice_agent_id !== ""
        ? parseInt(req.query.voice_agent_id, 10)
        : NaN;

    const conditions = [];
    const sqlParams = [];
    if (Number.isFinite(createdByFilter)) {
      conditions.push("va.created_by = ?");
      sqlParams.push(createdByFilter);
    }
    if (Number.isFinite(voiceAgentIdFilter)) {
      conditions.push("va.id = ?");
      sqlParams.push(voiceAgentIdFilter);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM voice_agents va ${whereSql}`,
      sqlParams
    );
    const totalAgents = Number(countRow?.total) || 0;

    const [rows] = await pool.query(
      `SELECT va.*,
        u.id AS creator_id,
        u.name AS creator_name,
        u.email AS creator_email,
        u.role AS creator_role
       FROM voice_agents va
       LEFT JOIN users u ON u.id = va.created_by
       ${whereSql}
       ORDER BY va.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...sqlParams, agentsLimit, agentsOffset]
    );

    const callStatus = req.query.call_status ? String(req.query.call_status).trim() : null;

    const results = await Promise.all(
      rows.map(async (row) => {
        const createdByAdmin =
          row.created_by != null && row.creator_id != null
            ? {
                id: row.creator_id,
                name: row.creator_name,
                email: row.creator_email,
                role: row.creator_role,
              }
            : null;

        const voiceAgent = {
          id: row.id,
          name: row.name,
          description: row.description,
          external_id: row.external_id,
          integrations: parseIntegrationsSafe(row.integrations),
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };

        const omniAgentId =
          row.external_id != null && row.external_id !== "" ? parseInt(row.external_id, 10) : NaN;
        if (!Number.isFinite(omniAgentId)) {
          return {
            voice_agent: voiceAgent,
            created_by_admin: createdByAdmin,
            call_logs: [],
            omnidim_error: "Agent has no Omnidim external_id. Create/sync the agent in Omni first.",
          };
        }

        const omniParams = {
          page: 1,
          page_size: callsPageSize,
          agent_id: omniAgentId,
        };
        if (callStatus) omniParams.call_status = callStatus;

        try {
          const raw = await omniRequest("GET", "/calls/logs", { params: omniParams });
          const items = flattenOmnidimCallLogsList(raw).map(withDirectionNormalized);
          return {
            voice_agent: voiceAgent,
            created_by_admin: createdByAdmin,
            call_logs: items,
            omnidim_error: null,
          };
        } catch (err) {
          console.error("Omnidim /calls/logs for agent", omniAgentId, err?.response?.data || err);
          return {
            voice_agent: voiceAgent,
            created_by_admin: createdByAdmin,
            call_logs: [],
            omnidim_error: err?.response?.data || err?.message || "Omnidim request failed",
          };
        }
      })
    );

    res.json({
      success: true,
      data: {
        agents: results,
        pagination: {
          agents_page: agentsPage,
          agents_limit: agentsLimit,
          agents_total: totalAgents,
          agents_total_pages: Math.max(1, Math.ceil(totalAgents / agentsLimit)),
          calls_per_agent: callsPageSize,
        },
      },
    });
  } catch (err) {
    console.error("listAgentsCallLogsByCreator error:", err);
    res.status(500).json({ success: false, message: "Failed to load agents and call logs." });
  }
}

module.exports = {
  createVoiceCall,
  createVoiceCallWithScript,
  getOmniCallLogs,
  getAdminOmniCallLogs,
  getCallLogsForAgent,
  getOmniCallLogById,
  createBulkCallFromUpload,
  listAgentsCallLogsByCreator,
  withDirectionNormalized,
  normalizePhone,
};
