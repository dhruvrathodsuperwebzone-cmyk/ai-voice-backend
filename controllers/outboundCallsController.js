const axios = require("axios");
const pool = require("../config/db");
const { ensureAgentsTable } = require("./omniAgentsController");
const { withDirectionNormalized } = require("./voiceController");

let usersCreatedByChecked = false;
async function ensureUsersCreatedBy() {
  if (usersCreatedByChecked) return;
  try {
    await pool.query("ALTER TABLE users ADD COLUMN created_by INT NULL");
  } catch (e) {
    const dup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
    if (!dup) throw e;
  }
  try {
    await pool.query(
      "ALTER TABLE users ADD CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL"
    );
  } catch {

  }
  usersCreatedByChecked = true;
}

let outboundTableChecked = false;
async function ensureOutboundCallRequestsTable() {
  if (outboundTableChecked) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbound_call_requests (
      id INT PRIMARY KEY AUTO_INCREMENT,
      initiated_by_user_id INT NOT NULL,
      contact_name VARCHAR(255) NOT NULL,
      phone VARCHAR(50) NOT NULL,
      selected_agent_id INT NULL,
      voice_agent_id INT NULL,
      status VARCHAR(50) DEFAULT 'queued',
      provider_response TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_outbound_initiator (initiated_by_user_id),
      INDEX idx_outbound_voice_agent (voice_agent_id),
      CONSTRAINT fk_outbound_initiator FOREIGN KEY (initiated_by_user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const alters = [
    "ALTER TABLE outbound_call_requests ADD COLUMN voice_agent_id INT NULL",
    "ALTER TABLE outbound_call_requests MODIFY COLUMN selected_agent_id INT NULL",
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      const dup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!dup && !String(e.message || "").includes("Unknown column")) throw e;
    }
  }
  try {
    await pool.query(`
      ALTER TABLE outbound_call_requests
      ADD CONSTRAINT fk_outbound_voice_agent FOREIGN KEY (voice_agent_id) REFERENCES voice_agents(id) ON DELETE SET NULL
    `);
  } catch {
    // duplicate or voice_agents missing until first omni use
  }
  const extra = [
    "ALTER TABLE outbound_call_requests ADD COLUMN campaign_id INT NULL",
    "ALTER TABLE outbound_call_requests ADD COLUMN lead_id INT NULL",
    "ALTER TABLE outbound_call_requests ADD COLUMN import_meta TEXT NULL",
    "ALTER TABLE outbound_call_requests ADD COLUMN provider_call_log_id BIGINT NULL",
  ];
  for (const sql of extra) {
    try {
      await pool.query(sql);
    } catch (e) {
      const dup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!dup) throw e;
    }
  }
  try {
    await pool.query(`
      ALTER TABLE outbound_call_requests
      ADD CONSTRAINT fk_outbound_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    `);
  } catch {
    // optional
  }
  try {
    await pool.query(`
      ALTER TABLE outbound_call_requests
      ADD CONSTRAINT fk_outbound_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
    `);
  } catch {
    // optional
  }
  try {
    await pool.query(`
      ALTER TABLE outbound_call_requests
      ADD CONSTRAINT fk_outbound_agent_user FOREIGN KEY (selected_agent_id) REFERENCES users(id) ON DELETE SET NULL
    `);
  } catch {
    // optional legacy
  }
  outboundTableChecked = true;
}

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/* ---------- Omnidim: same helpers as voiceController (GET /api/voice/calls) ---------- */

function getOmniConfig() {
  const apiKey = toOptionalString(process.env.OMNIDIM_API_KEY);
  const baseUrl = toOptionalString(process.env.OMNIDIM_BASE_URL) || "https://backend.omnidim.io/api/v1";
  return { apiKey, baseUrl };
}

async function omniRequest(method, endpointPath, { params, data } = {}) {
  const { apiKey, baseUrl } = getOmniConfig();
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
    timeout: 45000,
  });
  return resp.data;
}

function parseProviderResponseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePositiveIntId(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function unwrapOmniLogDetail(resp) {
  if (!resp || typeof resp !== "object") return null;
  if (resp.data != null && typeof resp.data === "object" && !Array.isArray(resp.data)) {
    return resp.data;
  }
  return resp;
}

function digitsOnly(v) {
  if (v == null) return "";
  return String(v).replace(/\D/g, "");
}

function phonesMatchDigits(wantDigits, toField) {
  const a = wantDigits ? String(wantDigits).replace(/\D/g, "") : "";
  const b = toField != null ? digitsOnly(toField) : "";
  if (!a || !b) return false;
  if (a === b) return true;
  const la = a.slice(-10);
  const lb = b.slice(-10);
  return la.length === 10 && lb.length === 10 && la === lb;
}

function omniDetailMatchesOutboundPhone(detail, outboundPhone) {
  if (!detail || typeof detail !== "object") return false;
  const want = digitsOnly(outboundPhone);
  if (!want) return false;
  const fields = [
    detail.to_number,
    detail.toNumber,
    detail.phone_number,
    detail.destination,
    detail.to,
    detail.called_number,
    detail.customer_phone_number,
  ];
  for (const f of fields) {
    if (phonesMatchDigits(want, f)) return true;
  }
  return false;
}

function flattenOmnidimListItems(data) {
  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  if (data?.results && Array.isArray(data.results)) return data.results;
  return [];
}

async function tryResolveOmnidimCallLogIdViaAgentList(row) {
  const agentId = parsePositiveIntId(row.voice_agent_external_id);
  if (!agentId) return null;
  const wantDigits = digitsOnly(row.phone);
  if (!wantDigits) return null;
  const rowTime = row.created_at ? new Date(row.created_at).getTime() : null;

  try {
    const data = await omniRequest("GET", "/calls/logs", {
      params: { page: 1, page_size: 100, agent_id: agentId },
    });
    const items = flattenOmnidimListItems(data);
    let best = null;
    let bestScore = Infinity;
    for (const item of items) {
      const to =
        item.to_number ??
        item.toNumber ??
        item.phone_number ??
        item.to ??
        item.destination ??
        item.customer_phone_number;
      if (!phonesMatchDigits(wantDigits, to)) continue;
      const tid = parsePositiveIntId(item.id);
      if (tid == null) continue;
      const t = item.created_at ?? item.time_of_call ?? item.started_at ?? item.recorded_at;
      const ts = t ? new Date(t).getTime() : null;
      const score =
        rowTime != null && ts != null && Number.isFinite(ts) ? Math.abs(ts - rowTime) : 1e15;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (best && best.id != null) return parsePositiveIntId(best.id);
  } catch {
    // ignore
  }
  return null;
}

function collectOmnidimCallLogIdCandidates(row) {
  const pr = parseProviderResponseJson(row.provider_response);
  const logIds = [];
  const reqIds = [];
  const pushUnique = (arr, v) => {
    const s = v != null && v !== "" ? String(v).trim() : "";
    if (!s || arr.includes(s)) return;
    arr.push(s);
  };
  pushUnique(logIds, row.provider_call_log_id);
  if (pr && typeof pr === "object") {
    pushUnique(logIds, pr.call_log_id);
    pushUnique(logIds, pr.callLogId);
    if (pr.data && typeof pr.data === "object") {
      pushUnique(logIds, pr.data.call_log_id);
      pushUnique(logIds, pr.data.callLogId);
    }
    pushUnique(reqIds, pr.requestId);
    pushUnique(reqIds, pr.request_id);
    if (pr.data && typeof pr.data === "object") {
      pushUnique(reqIds, pr.data.requestId);
      pushUnique(reqIds, pr.data.request_id);
    }
    if (pr.id != null && typeof pr.id !== "object") pushUnique(reqIds, pr.id);
    if (pr.data && typeof pr.data === "object") pushUnique(logIds, pr.data.id);
  }
  return [...logIds, ...reqIds];
}

function extractOmnidimCallLogIdFromProviderData(providerData) {
  if (!providerData || typeof providerData !== "object") return null;
  const p = providerData;
  const nested = p.data && typeof p.data === "object" ? p.data : null;
  const logFirst = [
    p.call_log_id,
    p.callLogId,
    nested?.call_log_id,
    nested?.callLogId,
    nested?.id,
  ];
  for (const c of logFirst) {
    if (c != null && typeof c === "object") continue;
    const n = parsePositiveIntId(c);
    if (n != null) return n;
  }
  const fallback = [p.requestId, p.request_id, nested?.requestId, p.id];
  for (const c of fallback) {
    if (c != null && typeof c === "object") continue;
    const n = parsePositiveIntId(c);
    if (n != null) return n;
  }
  return null;
}

async function updateOutboundRequestAfterDispatch(requestId, statusForRow, providerData, callLogId) {
  const json = providerData ? JSON.stringify(providerData) : null;
  try {
    await pool.query(
      "UPDATE outbound_call_requests SET status = ?, provider_response = ?, provider_call_log_id = COALESCE(?, provider_call_log_id) WHERE id = ?",
      [statusForRow, json, callLogId, requestId]
    );
  } catch (e) {
    const badCol = e.code === "ER_BAD_FIELD_ERROR" || e.errno === 1054;
    if (!badCol) throw e;
    await pool.query("UPDATE outbound_call_requests SET status = ?, provider_response = ? WHERE id = ?", [
      statusForRow,
      json,
      requestId,
    ]);
  }
}

/**
 * Full GET /calls/logs/:id object — same shape as items from GET /api/voice/calls.
 */
async function fetchOmnidimCallLogDetailForOutboundRow(row) {
  const idList = collectOmnidimCallLogIdCandidates(row);

  if (!toOptionalString(process.env.OMNIDIM_API_KEY)) {
    return null;
  }

  if (!idList.length) {
    const fromListOnly = await tryResolveOmnidimCallLogIdViaAgentList(row);
    if (fromListOnly == null) return null;
    try {
      const resp = await omniRequest("GET", `/calls/logs/${encodeURIComponent(fromListOnly)}`);
      const detail = unwrapOmniLogDetail(resp);
      if (detail && typeof detail === "object" && omniDetailMatchesOutboundPhone(detail, row.phone)) {
        return detail;
      }
    } catch {
      // fall through
    }
    return null;
  }

  for (const rawId of idList) {
    try {
      const resp = await omniRequest("GET", `/calls/logs/${encodeURIComponent(rawId)}`);
      const detail = unwrapOmniLogDetail(resp);
      if (detail && typeof detail === "object" && omniDetailMatchesOutboundPhone(detail, row.phone)) {
        return detail;
      }
    } catch {
      // try next
    }
  }

  const fromList = await tryResolveOmnidimCallLogIdViaAgentList(row);
  if (fromList != null) {
    try {
      const resp = await omniRequest("GET", `/calls/logs/${encodeURIComponent(fromList)}`);
      const detail = unwrapOmniLogDetail(resp);
      if (detail && typeof detail === "object") return detail;
    } catch {
      // ignore
    }
  }

  return null;
}

/** Same keys as typical GET /api/voice/calls items when Omnidim detail is not loaded yet. */
function fallbackOmnidimShapeFromOutboundRow(row) {
  const hint = collectOmnidimCallLogIdCandidates(row)[0];
  const idNum = parsePositiveIntId(hint);
  return {
    id: idNum,
    organization_branch_name: "",
    bot_name: row.voice_agent_name || "",
    is_bot_response: true,
    time_of_call: "",
    from_number: "",
    to_number: normalizePhone(row.phone) || row.phone || "",
    call_direction: "outbound",
    call_duration: "0:0",
    recording_url: false,
    internal_recording_url: false,
    recording_available_at: "",
    call_conversation: "",
    call_status: row.status || "unknown",
    channel_type: "Call",
    sentiment_score: "Neutral",
    sentiment_analysis_details: "",
    call_type: false,
    is_call_transfer: false,
    status: "",
    cqs_score: 0,
    cqs_score_message: false,
    metric_score_intent: 0,
    metric_score_relevance: 0,
    metric_score_latency: 0,
    metric_score_coherence: 0,
    p50_latency: 0,
    p99_latency: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    total_tts_speaking_minutes: 0,
    total_tts_speaking_seconds: 0,
    llm_prompt: false,
    aggregated_estimated_cost: 0,
    model_name: "",
    model_type: "chat",
    asr_service: "Azure",
    tts_service: "eleven_labs",
    has_issue: false,
    is_simulation: false,
    json_evolution_matrix_score: {},
    issues: [],
    call_duration_in_seconds: 0,
    call_duration_in_minutes: 0,
    extracted_variables: {
      user_name: "Not provided",
      company_name: "Not provided",
      interaction_count_total: 0,
    },
  };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if ((c === "," && !inQuotes) || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Match voiceController.normalizePhone — 10-digit India → +91… */
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

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/** Indian mobile: E.164 +91 + 10 digits (same rule as 10-digit local → +91). */
function isIndianMobileE164(phone) {
  const s = toOptionalString(phone);
  if (!s) return false;
  return /^\+91\d{10}$/.test(s.replace(/\s/g, ""));
}

/**
 * CSV columns: name, owner, phone, email, rooms, city (headers flexible).
 * Returns { rows: [{ name, owner, phone, phone_raw, email, rooms, city, line }], errors }
 * phone may be null if missing/invalid — classified later.
 */
function parseOutboundUploadCsv(buffer) {
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return { rows: [], errors: [{ line: 1, reason: "CSV must have a header row and at least one data row." }] };
  }
  const header = parseCsvLine(lines[0]).map(normalizeHeader);
  const phoneKey = header.find((h) => ["phone", "phone_number", "number", "mobile", "contact"].includes(h));
  if (!phoneKey) {
    return { rows: [], errors: [{ line: 1, reason: "Missing phone column (expected phone, phone_number, number, mobile, or contact)." }] };
  }
  const nameKey = header.find((h) => h === "name");
  const ownerKey = header.find((h) => ["owner", "owner_name", "contact_name"].includes(h));
  const emailKey = header.find((h) => ["email", "email_id"].includes(h));
  const roomsKey = header.find((h) => ["rooms", "room", "room_count"].includes(h));
  const cityKey = header.find((h) => ["city", "location", "area"].includes(h));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, j) => {
      row[h] = values[j] != null ? String(values[j]).trim() : "";
    });
    const phoneRaw = row[phoneKey];
    const phone = normalizePhone(phoneRaw);
    const owner = ownerKey ? row[ownerKey] : "";
    const nm = nameKey ? row[nameKey] : "";
    rows.push({
      name: nm || null,
      owner: owner || null,
      phone,
      phone_raw: phoneRaw != null ? String(phoneRaw).trim() : "",
      email: emailKey ? row[emailKey] || null : null,
      rooms: roomsKey && row[roomsKey] !== "" ? row[roomsKey] : null,
      city: cityKey ? row[cityKey] || null : null,
      line: i + 1,
    });
  }
  return { rows, errors: [] };
}

/**
 * First occurrence wins; skips duplicate normalized numbers, non-Indian numbers, invalid numbers.
 */
function buildCsvDialQueue(rows) {
  const seen = new Set();
  const toDial = [];
  const skipped = [];

  for (const r of rows) {
    if (!r.phone) {
      skipped.push({
        line: r.line,
        phone_raw: r.phone_raw || null,
        normalized_phone: null,
        reason: "invalid",
      });
      continue;
    }
    if (!isIndianMobileE164(r.phone)) {
      skipped.push({
        line: r.line,
        phone_raw: r.phone_raw || null,
        normalized_phone: r.phone,
        reason: "international",
      });
      continue;
    }
    if (seen.has(r.phone)) {
      skipped.push({
        line: r.line,
        phone_raw: r.phone_raw || null,
        normalized_phone: r.phone,
        reason: "duplicate",
      });
      continue;
    }
    seen.add(r.phone);
    toDial.push(r);
  }

  return { toDial, skipped };
}

/**
 * GET /api/calls/outbound/agents
 * Dropdown: voice_agents.created_by = you (admin & agent).
 * Viewer: all rows (read-only; POST outbound / CSV still admin+agent only).
 */
async function listAgentsForOutbound(req, res) {
  try {
    await ensureAgentsTable();

    const uid = req.user.id;
    const role = req.user.role;

    if (role !== "admin" && role !== "agent" && role !== "viewer") {
      return res.status(403).json({ success: false, message: "You don't have permission to do this." });
    }

    const [rows] =
      role === "viewer"
        ? await pool.query(
            `SELECT id, name, external_id, description, created_at
             FROM voice_agents
             ORDER BY name ASC`
          )
        : await pool.query(
            `SELECT id, name, external_id, description, created_at
             FROM voice_agents
             WHERE created_by = ?
             ORDER BY name ASC`,
            [uid]
          );

    return res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        external_id: r.external_id ?? null,
        description: r.description ?? null,
        source: "omni_voice_agent",
      })),
    });
  } catch (err) {
    console.error("List outbound agents error:", err);
    res.status(500).json({ success: false, message: "Could not load agents." });
  }
}

/**
 * GET /api/calls/outbound/admin/agents (admin only)
 * Every row in voice_agents (all users), same base fields as GET /calls/outbound/agents plus creator.
 */
async function listAgentsForOutboundAdmin(req, res) {
  try {
    await ensureAgentsTable();

    const [rows] = await pool.query(
      `SELECT va.id, va.name, va.external_id, va.description, va.created_by, va.created_at, va.updated_at,
        u.name AS creator_name,
        u.email AS creator_email,
        u.role AS creator_role
       FROM voice_agents va
       LEFT JOIN users u ON u.id = va.created_by
       ORDER BY va.name ASC`
    );

    return res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        external_id: r.external_id ?? null,
        description: r.description ?? null,
        created_by: r.created_by ?? null,
        creator_name: r.creator_name ?? null,
        creator_email: r.creator_email ?? null,
        creator_role: r.creator_role ?? null,
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
        source: "omni_voice_agent",
      })),
    });
  } catch (err) {
    console.error("List outbound agents (admin) error:", err);
    res.status(500).json({ success: false, message: "Could not load agents." });
  }
}

/** @param {string|null|undefined} initiatorRole e.g. req.user.role; omit for strict ownership (own agents only). */
async function assertSelectableVoiceAgent(initiatorId, voiceAgentId, initiatorRole = null) {
  const [rows] = await pool.query(
    "SELECT id, name, created_by, external_id FROM voice_agents WHERE id = ?",
    [voiceAgentId]
  );
  if (!rows.length) return { ok: false, message: "Agent not found." };
  const va = rows[0];

  if (initiatorRole === "admin") {
    return { ok: true, row: va };
  }

  if (va.created_by != null && va.created_by !== initiatorId) {
    return { ok: false, message: "You can only use voice agents you created." };
  }
  if (va.created_by == null) {
    return { ok: false, message: "This voice agent is not linked to your account." };
  }
  return { ok: true, row: va };
}

/** Omni dispatch API expects the dashboard agent id (external_id), not our DB row id. */
function resolveOmniAgentIdForPayload(row) {
  const ext = toOptionalString(row?.external_id);
  if (!ext) return null;
  const n = parseInt(ext, 10);
  return Number.isFinite(n) ? n : ext;
}

/**
 * Turn Omni HTTP body (or axios error payload) into a single UI-friendly outcome.
 * Treats success:true / status: dispatched|created|queued as success.
 */
function interpretOutboundProviderOutcome(providerData, axiosError) {
  if (axiosError) {
    const d = axiosError.response?.data;
    const raw =
      d?.error_description ??
      d?.message ??
      d?.error ??
      axiosError.message ??
      "Call could not be started.";
    const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
    return {
      ok: false,
      message: msg,
      request_id: d?.requestId ?? d?.request_id ?? null,
      provider_status: null,
      error: d?.error != null ? String(d.error) : "request_failed",
      error_description: msg,
    };
  }

  const p = providerData && typeof providerData === "object" ? providerData : {};
  const statusRaw = toOptionalString(p.status);
  const statusLower = statusRaw ? statusRaw.toLowerCase() : "";
  const positiveStatus = ["dispatched", "created", "queued", "success", "ringing", "in_progress", "completed"];
  const requestId = p.requestId ?? p.request_id ?? p.id ?? null;

  if (p.success === true) {
    let message = "Call was sent successfully.";
    if (statusLower === "dispatched") message = "Call was dispatched successfully.";
    else if (statusLower === "created") message = "Call was created successfully.";
    return {
      ok: true,
      message,
      request_id: requestId,
      provider_status: statusRaw || "ok",
      error: null,
      error_description: null,
    };
  }

  if (p.error != null || p.success === false) {
    const msg =
      toOptionalString(p.error_description) ||
      toOptionalString(p.message) ||
      toOptionalString(p.error) ||
      "Call could not be started.";
    return {
      ok: false,
      message: msg,
      request_id: requestId,
      provider_status: statusRaw || null,
      error: p.error != null ? String(p.error) : "error",
      error_description: msg,
    };
  }

  if (statusLower && positiveStatus.includes(statusLower)) {
    return {
      ok: true,
      message: "Call was sent successfully.",
      request_id: requestId,
      provider_status: statusRaw,
      error: null,
      error_description: null,
    };
  }

  return {
    ok: false,
    message: "Unexpected response from the call provider.",
    request_id: requestId,
    provider_status: statusRaw || null,
    error: "unknown_response",
    error_description: null,
  };
}

/**
 * Omnidim “caller line” id from the dashboard (e.g. ID: #2410 next to +918048799723).
 * Sent on dispatch as `from_number_id`. When `OMNIDIM_FROM_NUMBER_ID` or `OMNIDIM_PHONE_NUMBER_ID`
 * is set, that value is used (clients do not need to pass `from_number_id`).
 */
function resolveDefaultOmnidimFromNumberId() {
  const raw =
    toOptionalString(process.env.OMNIDIM_FROM_NUMBER_ID) ||
    toOptionalString(process.env.OMNIDIM_PHONE_NUMBER_ID);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}


/**
 * Core outbound dial (Omni). Used by HTTP handler and campaign dialer.
 * @returns {Promise<{ ok: boolean, message: string, outcome: object, requestId: number, providerData: any, row: any, from_number_id_used: number|null }>}
 */
async function dispatchOutboundCallCore({
  initiatorUserId,
  initiatorRole = null,
  contactName,
  phone,
  voiceAgentId,
  campaignId = null,
  leadId = null,
  fromNumberId = null,
  fromNumberOverride = null,
  fromNumberEnvFallback = true,
  importMeta = null,
}) {
  await ensureAgentsTable();
  await ensureOutboundCallRequestsTable();

  const check = await assertSelectableVoiceAgent(initiatorUserId, voiceAgentId, initiatorRole);
  if (!check.ok) {
    return {
      ok: false,
      message: check.message,
      outcome: null,
      requestId: null,
      providerData: null,
      row: null,
      from_number_id_used: null,
    };
  }

  const omniAgentId = resolveOmniAgentIdForPayload(check.row);
  if (omniAgentId == null) {
    return {
      ok: false,
      message:
        "This agent has no Omni ID saved. Create the agent with POST /api/omni/agents (or fix external_id in the database) so it matches the ID on omnidim.io.",
      outcome: null,
      requestId: null,
      providerData: null,
      row: null,
      from_number_id_used: null,
    };
  }

  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) {
    return {
      ok: false,
      message: "Invalid phone number. Use 10-digit India or +91… E.164.",
      outcome: null,
      requestId: null,
      providerData: null,
      row: null,
      from_number_id_used: null,
    };
  }
  phone = phoneNorm;

  const metaJson = importMeta && typeof importMeta === "object" ? JSON.stringify(importMeta) : null;
  let requestId;
  try {
    const [r] = await pool.query(
      `INSERT INTO outbound_call_requests
       (initiated_by_user_id, contact_name, phone, voice_agent_id, status, campaign_id, lead_id, import_meta)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [initiatorUserId, contactName, phone, voiceAgentId, campaignId, leadId, metaJson]
    );
    requestId = r.insertId;
  } catch (insErr) {
    const badCol = insErr.code === "ER_BAD_FIELD_ERROR" || insErr.errno === 1054;
    if (!badCol) throw insErr;
    const [r2] = await pool.query(
      `INSERT INTO outbound_call_requests
       (initiated_by_user_id, contact_name, phone, voice_agent_id, status, campaign_id, lead_id)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      [initiatorUserId, contactName, phone, voiceAgentId, campaignId, leadId]
    );
    requestId = r2.insertId;
  }

  const explicitFrom =
    fromNumberId != null && fromNumberId !== "" ? parseInt(fromNumberId, 10) : NaN;
  const envLineId = resolveDefaultOmnidimFromNumberId();
  // Env wins when set so the backend owns the caller line; body is only a fallback if env is unset.
  const fromNumberIdResolvedForPayload =
    envLineId != null && envLineId > 0
      ? envLineId
      : Number.isFinite(explicitFrom) && explicitFrom > 0
        ? explicitFrom
        : null;

  let providerData = null;
  let axiosError = null;
  try {
    const { OMNIDIM_API_KEY, OMNIDIM_BASE_URL, OMNIDIM_CALL_PATH, OMNIDIM_PHONE_NUMBER } = process.env;
    if (!OMNIDIM_API_KEY) {
      throw new Error("Missing OMNIDIM_API_KEY in environment.");
    }
    const apiKey = String(OMNIDIM_API_KEY).trim();
    const baseUrl = (OMNIDIM_BASE_URL && String(OMNIDIM_BASE_URL).trim()) || "https://backend.omnidim.io/api/v1";
    const callPath = (OMNIDIM_CALL_PATH && String(OMNIDIM_CALL_PATH).trim()) || "/calls/dispatch";
    const endpoint = `${baseUrl.replace(/\/+$/, "")}${callPath.startsWith("/") ? callPath : `/${callPath}`}`;

    const fromNumberRaw =
      toOptionalString(fromNumberOverride) ||
      (fromNumberEnvFallback && OMNIDIM_PHONE_NUMBER ? String(OMNIDIM_PHONE_NUMBER).trim() : null);
    const fromNumber = fromNumberRaw ? normalizePhone(fromNumberRaw) || fromNumberRaw : null;

    const payload = {
      agent_id: omniAgentId,
      to_number: phone,
      ...(fromNumberIdResolvedForPayload != null && fromNumberIdResolvedForPayload > 0
        ? { from_number_id: fromNumberIdResolvedForPayload }
        : {}),
      call_context: {
        user_id: initiatorUserId,
        contact_name: contactName,
        request_id: requestId,
        voice_agent_row_id: voiceAgentId,
        campaign_id: campaignId,
        lead_id: leadId,
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
      timeout: 30000,
    });

    providerData = omni.data || null;
  } catch (callErr) {
    console.error("Outbound Omni call error:", callErr?.response?.data || callErr);
    axiosError = callErr;
    providerData = callErr?.response?.data || { error: callErr.message || "Call failed" };
  }

  const outcome = interpretOutboundProviderOutcome(providerData, axiosError);
  const statusForRow = outcome.ok
    ? toOptionalString(outcome.provider_status) || "sent"
    : "failed";

  const callLogId = extractOmnidimCallLogIdFromProviderData(providerData);
  await updateOutboundRequestAfterDispatch(requestId, statusForRow, providerData, callLogId);

  const [rows] = await pool.query("SELECT * FROM outbound_call_requests WHERE id = ?", [requestId]);
  const topMessage = outcome.ok
    ? "Call sent successfully."
    : `Call not sent: ${outcome.error_description || outcome.message || "Unknown error"}`;

  return {
    ok: outcome.ok,
    message: topMessage,
    outcome,
    requestId,
    providerData,
    row: rows[0] || null,
    from_number_id_used: fromNumberIdResolvedForPayload != null ? fromNumberIdResolvedForPayload : null,
  };
}

/**
 * POST /api/calls/outbound
 * Body: { name | contact_name, phone | number, agent_id, from_number_id? }
 * agent_id = voice_agents.id. Admins may use any saved agent; agents only agents they created.
 * Caller line: set OMNIDIM_FROM_NUMBER_ID or OMNIDIM_PHONE_NUMBER_ID on the server (preferred).
 * Optional body from_number_id is used only when those env vars are unset.
 */
async function createOutboundCall(req, res) {
  try {
    const role = req.user.role;
    if (role === "viewer") {
      return res.status(403).json({ success: false, message: "You don't have permission to do this." });
    }
    if (role !== "admin" && role !== "agent") {
      return res.status(403).json({ success: false, message: "You don't have permission to do this." });
    }

    const body = req.body || {};
    const contactName = toOptionalString(body.name ?? body.contact_name);
    const phoneRaw = toOptionalString(body.phone ?? body.number ?? body.mobile);
    const agentIdRaw = body.agent_id ?? body.voice_agent_id ?? body.selected_agent_id;
    const voiceAgentId = agentIdRaw != null && agentIdRaw !== "" ? parseInt(agentIdRaw, 10) : NaN;

    if (!contactName) {
      return res.status(400).json({ success: false, message: "Name is required." });
    }
    if (!phoneRaw) {
      return res.status(400).json({ success: false, message: "Phone number is required." });
    }
    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number. Use 10-digit India or +91… E.164.",
      });
    }
    if (!Number.isFinite(voiceAgentId)) {
      return res.status(400).json({ success: false, message: "Please choose an agent." });
    }

    const fromNumberId =
      body.from_number_id != null && body.from_number_id !== "" ? parseInt(body.from_number_id, 10) : null;
    const fromNumberOverride = toOptionalString(body.from_number);

    const cid = body.campaign_id != null && body.campaign_id !== "" ? parseInt(body.campaign_id, 10) : NaN;
    const lid = body.lead_id != null && body.lead_id !== "" ? parseInt(body.lead_id, 10) : NaN;
    const result = await dispatchOutboundCallCore({
      initiatorUserId: req.user.id,
      initiatorRole: req.user.role,
      contactName,
      phone,
      voiceAgentId,
      campaignId: Number.isFinite(cid) ? cid : null,
      leadId: Number.isFinite(lid) ? lid : null,
      fromNumberId: Number.isFinite(fromNumberId) ? fromNumberId : null,
      fromNumberOverride,
      fromNumberEnvFallback: !fromNumberOverride,
    });

    if (!result.ok && result.requestId == null) {
      return res.status(400).json({ success: false, message: result.message });
    }

    res.status(201).json({
      success: result.ok,
      message: result.message,
      data: {
        request: result.row,
        provider_response: result.providerData,
        from_number_id_used: result.from_number_id_used,
        call_result: {
          sent: result.ok,
          provider_request_id: result.outcome?.request_id,
          provider_status: result.outcome?.provider_status,
          error: result.outcome?.error,
          error_description: result.outcome?.error_description,
        },
      },
    });
  } catch (err) {
    console.error("Create outbound call error:", err);
    res.status(500).json({ success: false, message: "Could not create call." });
  }
}

/**
 * GET /api/calls/outbound/requests?page=1&limit=20
 * Only rows you initiated (other admins never see yours).
 *
 * Response `data` is an array of Omnidim call log objects — **same shape as GET /api/voice/calls**
 * (each item passed through withDirectionNormalized). Rows without a resolvable Omnidim log are omitted.
 * Use `?lite=1` for raw `outbound_call_requests` DB rows (no Omnidim HTTP calls).
 */
async function listMyOutboundRequests(req, res) {
  try {
    await ensureOutboundCallRequestsTable();

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const lite =
      req.query.lite === "1" ||
      req.query.lite === "true" ||
      String(req.query.format || "").toLowerCase() === "legacy";

    const [[countRow]] = await pool.query(
      "SELECT COUNT(*) AS total FROM outbound_call_requests WHERE initiated_by_user_id = ?",
      [req.user.id]
    );
    const total = countRow.total;

    const [rows] = await pool.query(
      `SELECT o.*,
        va.name AS voice_agent_name,
        va.external_id AS voice_agent_external_id,
        u.name AS legacy_user_agent_name,
        u.email AS legacy_user_agent_email
       FROM outbound_call_requests o
       LEFT JOIN voice_agents va ON va.id = o.voice_agent_id
       LEFT JOIN users u ON u.id = o.selected_agent_id
       WHERE o.initiated_by_user_id = ?
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    if (lite) {
      res.json({
        success: true,
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
      return;
    }

    const data = await Promise.all(
      rows.map(async (row) => {
        const detail = await fetchOmnidimCallLogDetailForOutboundRow(row);
        return withDirectionNormalized(detail || fallbackOmnidimShapeFromOutboundRow(row));
      })
    );

    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error("List outbound requests error:", err);
    res.status(500).json({ success: false, message: "Could not load call history." });
  }
}

/**
 * POST /api/calls/outbound/csv
 * multipart: field `file` = CSV with columns name, owner, phone, email, rooms, city (phone required).
 * form field: agent_id (voice_agents.id) — same as POST /api/calls/outbound.
 * Each row creates one outbound_call_requests row (same table) and dials via Omni.
 */
async function createOutboundCallsFromCsv(req, res) {
  try {
    const role = req.user.role;
    if (role === "viewer") {
      return res.status(403).json({ success: false, message: "You don't have permission to do this." });
    }
    if (role !== "admin" && role !== "agent") {
      return res.status(403).json({ success: false, message: "You don't have permission to do this." });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "CSV file is required (form field name: file)." });
    }

    const agentIdRaw = req.body?.agent_id ?? req.body?.voice_agent_id;
    const voiceAgentId = agentIdRaw != null && agentIdRaw !== "" ? parseInt(agentIdRaw, 10) : NaN;
    if (!Number.isFinite(voiceAgentId)) {
      return res.status(400).json({ success: false, message: "agent_id (voice agent) is required." });
    }

    const { rows, errors: parseErrors } = parseOutboundUploadCsv(req.file.buffer);
    if (parseErrors.length) {
      return res.status(400).json({ success: false, message: "Could not parse CSV.", data: { parse_errors: parseErrors } });
    }

    const maxRows = Math.min(500, Math.max(1, parseInt(process.env.OUTBOUND_CSV_MAX_ROWS || "200", 10) || 200));
    if (rows.length > maxRows) {
      return res.status(400).json({
        success: false,
        message: `Too many rows (max ${maxRows}). Split the file or raise OUTBOUND_CSV_MAX_ROWS.`,
      });
    }
    if (!rows.length) {
      return res.status(400).json({ success: false, message: "No data rows in CSV." });
    }

    const { toDial, skipped } = buildCsvDialQueue(rows);
    const summary = {
      total_data_rows: rows.length,
      skipped_duplicate: skipped.filter((s) => s.reason === "duplicate").length,
      skipped_international: skipped.filter((s) => s.reason === "international").length,
      skipped_invalid: skipped.filter((s) => s.reason === "invalid").length,
      to_dial: toDial.length,
    };

    await ensureOutboundCallRequestsTable();

    const batchId = `csv_${Date.now()}_${req.user.id}`;
    const delayMs = Math.max(0, parseInt(process.env.OUTBOUND_CSV_DELAY_MS || "600", 10) || 600);
    const results = [];

    if (!toDial.length) {
      return res.status(200).json({
        success: true,
        message: "No calls placed — all rows were invalid, international, or duplicate.",
        data: {
          batch_id: batchId,
          initiated_by_user_id: req.user.id,
          summary,
          skipped,
          dial_results: [],
        },
      });
    }

    for (let i = 0; i < toDial.length; i++) {
      const r = toDial[i];
      const contactName = toOptionalString(r.owner) || toOptionalString(r.name) || "Contact";
      const importMeta = {
        source: "csv_upload",
        batch_id: batchId,
        csv_row: r.line,
        name: r.name,
        owner: r.owner,
        email: r.email,
        rooms: r.rooms,
        city: r.city,
        original_filename: req.file.originalname || null,
      };

      const result = await dispatchOutboundCallCore({
        initiatorUserId: req.user.id,
        initiatorRole: req.user.role,
        contactName,
        phone: r.phone,
        voiceAgentId,
        importMeta,
        fromNumberEnvFallback: true,
      });

      results.push({
        line: r.line,
        phone: r.phone,
        ok: result.ok,
        message: result.message,
        request_id: result.requestId,
      });

      if (i < toDial.length - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const anyOk = results.some((x) => x.ok);
    res.status(201).json({
      success: anyOk,
      message: anyOk ? "CSV processing finished (see per-row results)." : "No calls were sent successfully.",
      data: {
        batch_id: batchId,
        initiated_by_user_id: req.user.id,
        summary,
        skipped,
        dial_attempts: results.length,
        dial_results: results,
      },
    });
  } catch (err) {
    console.error("Outbound CSV error:", err);
    res.status(500).json({ success: false, message: "Could not process CSV upload." });
  }
}

module.exports = {
  listAgentsForOutbound,
  listAgentsForOutboundAdmin,
  createOutboundCall,
  createOutboundCallsFromCsv,
  listMyOutboundRequests,
  ensureUsersCreatedBy,
  dispatchOutboundCallCore,
  ensureOutboundCallRequestsTable,
  assertSelectableVoiceAgent,
  resolveOmniAgentIdForPayload,
};
