const axios = require("axios");
const pool = require("../config/db");

let tableChecked = false;
async function ensureAgentsTable() {
  if (tableChecked) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS voice_agents (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      external_id VARCHAR(255) NULL,
      integrations TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )`
  );
  tableChecked = true;
}

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function getOmniConfig() {
  const apiKey = toOptionalString(process.env.OMNIDIM_API_KEY);
  const baseUrl = toOptionalString(process.env.OMNIDIM_BASE_URL) || "https://backend.omnidim.io/api/v1";
  return { apiKey, baseUrl };
}

function buildUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function omniRequest(method, endpointPath, { params, data } = {}) {
  const { apiKey, baseUrl } = getOmniConfig();
  if (!apiKey) {
    const err = new Error("Missing OMNIDIM_API_KEY in environment.");
    err.status = 500;
    throw err;
  }
  const url = buildUrl(baseUrl, endpointPath);
  const resp = await axios({
    method,
    url,
    params,
    data,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 60000,
  });
  return resp.data;
}

function sendOmniError(res, err) {
  if (err.status === 500 && err.message) {
    return res.status(500).json({ success: false, message: err.message });
  }
  const status = err.response?.status || 500;
  const payload = err.response?.data;
  const msg =
    payload?.error_description ||
    payload?.message ||
    payload?.error ||
    err.message ||
    "OmniDimension request failed.";
  res.status(status).json({ success: false, message: msg, omni: payload ?? null });
}

function safeParseJson(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function agentRowToObject(row) {
  const integrations = safeParseJson(row.integrations);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    external_id: row.external_id ?? null,
    welcome_message: integrations?.welcome_message ?? null,
    context_breakdown: integrations?.context_breakdown ?? null,
    integrations,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Omnidim GET /agents/:id may return the agent at top level or under `data` / `agent`. */
function unwrapOmniAgentDetail(raw) {
  if (raw == null || typeof raw !== "object") return {};
  if (raw.data != null && typeof raw.data === "object" && !Array.isArray(raw.data)) return raw.data;
  if (raw.agent != null && typeof raw.agent === "object") return raw.agent;
  return raw;
}

function pickLiveFieldsFromOmniDetail(raw) {
  const d = unwrapOmniAgentDetail(raw);
  const name = d.name != null && String(d.name).trim() !== "" ? String(d.name).trim() : null;
  const welcome_message = d.welcome_message != null ? String(d.welcome_message) : null;
  const description =
    d.description != null && String(d.description).trim() !== "" ? String(d.description).trim() : null;
  let context_breakdown = d.context_breakdown ?? d.flow;
  if (!Array.isArray(context_breakdown)) context_breakdown = null;
  return { name, welcome_message, description, context_breakdown };
}

/**
 * One list-style agent row for admin GET (merges live Omnidim with optional voice_agents cache).
 */
function buildAdminOmnidimAgentDetailItem(externalId, omniRaw, localRow) {
  const live = pickLiveFieldsFromOmniDetail(omniRaw);
  const localObj = localRow ? agentRowToObject(localRow) : null;
  const integrationsBase = localRow ? safeParseJson(localRow.integrations) || {} : {};

  const name = live.name ?? localObj?.name ?? "Agent";
  const description = live.description ?? localObj?.description ?? null;
  const welcome_message = live.welcome_message ?? localObj?.welcome_message ?? null;
  const context_breakdown = live.context_breakdown ?? localObj?.context_breakdown ?? null;

  const use_case_category =
    integrationsBase.use_case_category != null && String(integrationsBase.use_case_category).trim() !== ""
      ? String(integrationsBase.use_case_category).trim()
      : description;

  const integrations = {
    ...integrationsBase,
    name,
    welcome_message,
    description,
    use_case_category: use_case_category ?? null,
    context_breakdown,
  };

  return {
    id: localRow?.id ?? null,
    name,
    description,
    external_id: String(externalId),
    welcome_message,
    context_breakdown,
    integrations,
    created_by: localRow?.created_by ?? null,
    created_at: localRow?.created_at ?? null,
    updated_at: localRow?.updated_at ?? null,
  };
}

/** Each flow row gets `title` + `body` (many UIs bind these; Omnidim uses context_title / context_body). */
function normalizeFlowItemForClient(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const title = String(entry.title ?? entry.context_title ?? "").trim();
  const body = String(entry.body ?? entry.context_body ?? "").trim();
  return { ...entry, title, body };
}

function normalizeFlowArrayForClient(flow) {
  if (!Array.isArray(flow)) return flow;
  return flow.map(normalizeFlowItemForClient);
}

/** Strip secrets before returning Omnidim payload to the browser. */
function omitOmnidimSecretsForClient(raw) {
  let copy;
  try {
    copy = raw == null ? raw : JSON.parse(JSON.stringify(raw));
  } catch {
    copy = raw;
  }
  if (!copy || typeof copy !== "object") return copy;
  if (Object.prototype.hasOwnProperty.call(copy, "secret_key")) copy.secret_key = null;
  if (copy.widget_config && typeof copy.widget_config === "object" && typeof copy.widget_config.iframeUrl === "string") {
    copy.widget_config = { ...copy.widget_config };
    copy.widget_config.iframeUrl = copy.widget_config.iframeUrl.replace(/([?&])secret=[^&]*/i, "$1secret=***");
  }
  return copy;
}

/**
 * Extra keys for edit forms: camelCase + normalized flow (title/body on every section).
 */
function enrichAdminAgentDetailForClient(item) {
  const context_breakdown = normalizeFlowArrayForClient(item.context_breakdown);
  const integrations =
    item.integrations && typeof item.integrations === "object"
      ? {
          ...item.integrations,
          context_breakdown: normalizeFlowArrayForClient(item.integrations.context_breakdown),
        }
      : item.integrations;

  return {
    ...item,
    context_breakdown,
    integrations,
    welcomeMessage: item.welcome_message ?? null,
    contextBreakdown: context_breakdown,
    externalId: item.external_id ?? null,
  };
}

/** Map UI / Omnidim flow row to { title, body, is_enabled?, id? } for PUT /agents/:id */
function normalizeIncomingFlowRow(b) {
  if (!b || typeof b !== "object") return null;
  const title = String(b.title ?? b.context_title ?? "").trim();
  const body = String(b.body ?? b.context_body ?? "").trim();
  if (!title || !body) return null;
  const out = { title, body, is_enabled: b.is_enabled !== false };
  const idNum = b.id != null ? Number(b.id) : NaN;
  if (Number.isFinite(idNum)) out.id = idNum;
  return out;
}

function extractFlowArrayFromOmniAgentRaw(raw) {
  const d = unwrapOmniAgentDetail(raw);
  const flow = d.context_breakdown ?? d.flow;
  return Array.isArray(flow) ? flow : [];
}

/** Omnidim updates often require each flow step `id` — merge from live GET when client omits ids. */
function enrichFlowRowsWithLiveIds(normalizedFlow, liveFlow) {
  if (!Array.isArray(normalizedFlow) || !normalizedFlow.length) return normalizedFlow;
  if (!Array.isArray(liveFlow) || !liveFlow.length) return normalizedFlow;

  return normalizedFlow.map((row, i) => {
    if (row.id != null && Number.isFinite(Number(row.id))) return row;
    const liveItem =
      liveFlow[i] && typeof liveFlow[i] === "object"
        ? liveFlow[i]
        : liveFlow.find(
            (l) =>
              String(l.title ?? l.context_title ?? "")
                .trim()
                .toLowerCase() === String(row.title).trim().toLowerCase()
          );
    if (!liveItem || typeof liveItem !== "object") return row;
    const idRaw = liveItem.id ?? liveItem.flow_id ?? liveItem.context_id;
    const idNum = idRaw != null ? Number(idRaw) : NaN;
    if (Number.isFinite(idNum)) return { ...row, id: idNum };
    return row;
  });
}

/** Payload keys Omnidim PUT expects on each flow item (avoid leaking extra client keys). */
function shapeFlowRowForOmniPut(row) {
  const out = {
    title: row.title,
    body: row.body,
    is_enabled: row.is_enabled !== false,
  };
  if (row.id != null && Number.isFinite(Number(row.id))) out.id = Number(row.id);
  return out;
}

function pickOmniAgentId(omniResponse) {
  if (!omniResponse || typeof omniResponse !== "object") return null;
  return (
    omniResponse.id ??
    omniResponse.agent_id ??
    omniResponse.agentId ??
    omniResponse._id ??
    null
  );
}

function generateWelcomeMessage(body) {
  const name = body?.name ? String(body.name).trim() : "";
  const useCase = body?.use_case_category ? String(body.use_case_category).trim() : "";
  if (body?.welcome_message && String(body.welcome_message).trim()) return String(body.welcome_message).trim();
  if (useCase) return `Hi, I am your ${useCase} assistant. How can I help you today?`;
  if (name) return `Hi, I'm ${name}. How can I help you today?`;
  return "Hi, I'm your assistant. How can I help you today?";
}

function generateContextBreakdown(body) {
  const flowPrompt =
    body?.flow_prompt != null && String(body.flow_prompt).trim()
      ? String(body.flow_prompt).trim()
      : body?.instructions != null && String(body.instructions).trim()
        ? String(body.instructions).trim()
        : body?.description != null && String(body.description).trim()
          ? String(body.description).trim()
          : "";

  const useCaseRaw =
    body?.use_case_category != null
      ? String(body.use_case_category).trim()
      : body?.agent_type != null
        ? String(body.agent_type).trim()
        : body?.description != null
          ? String(body.description).trim()
          : "";
  const useCase = useCaseRaw.toLowerCase();

  // Generic conversation flow; can be specialized by use_case_category.
  const basePurpose = flowPrompt
    ? `Your goal is: ${flowPrompt}`
    : "Your goal is to understand the caller request and guide them to the next step.";

  let nextStep = "Collect the required details and then confirm the next step with the user.";
  if (useCase.includes("lead")) nextStep = "Collect lead details (name, phone, email if available) and confirm what happens next.";
  else if (useCase.includes("appointment") || useCase.includes("booking"))
    nextStep = "Collect appointment intent and required details (date/time preference, name, phone/email) and confirm.";
  else if (useCase.includes("support") || useCase.includes("issue"))
    nextStep = "Collect the issue details, summarize the problem, and propose a resolution path.";
  else if (useCase.includes("negotiation"))
    nextStep = "Handle objections politely, summarize value, and close with a clear next action.";
  else if (useCase.includes("collection"))
    nextStep = "Collect payment/account details and guide to the next payment/collection action.";

  return [
    {
      title: "Purpose",
      body: `${basePurpose} Follow the flow sections in order.`,
      is_enabled: true,
    },
    {
      title: "Information Gathering",
      body:
        "Ask concise questions to understand the caller intent. Collect these if applicable: full name, best contact number, email (if offered), and key needs/requirements. If the user gives partial information, ask follow-ups.",
      is_enabled: true,
    },
    {
      title: "Conversation Handling",
      body:
        "Keep responses natural and helpful. If the caller asks something unrelated, guide them back to the goal. If the user is unhappy, empathize and offer alternatives.",
      is_enabled: true,
    },
    {
      title: "Extract Variables",
      body:
        "At the end of the conversation (or whenever enough info is available), prepare extracted variables for downstream actions: caller_name, phone, email, intent, key_details, and any date/time preferences.",
      is_enabled: true,
    },
    {
      title: "Next Step & Close",
      body: `${nextStep} End with a clear confirmation of what will happen next and a polite closing.`,
      is_enabled: true,
    },
  ];
}

/**
 * POST /api/omni/agents
 * Proxies to OmniDimension POST /agents/create. Body is forwarded as JSON.
 * Required by Omni: name, welcome_message, context_breakdown (see their docs).
 */
async function createAgent(req, res) {
  try {
    await ensureAgentsTable();
    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ success: false, message: "JSON body is required." });
    }
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ success: false, message: "name is required." });
    }

    // Minimal inputs: name + welcome_message + description (agent type).
    if (!body.welcome_message || !String(body.welcome_message).trim()) {
      return res.status(400).json({ success: false, message: "welcome_message is required." });
    }
    if (!body.description || !String(body.description).trim()) {
      return res.status(400).json({ success: false, message: "description (agent type) is required." });
    }

    body.welcome_message = String(body.welcome_message).trim();
    body.description = String(body.description).trim();
    body.use_case_category = body.use_case_category || body.agent_type || body.description;

    // Auto-generate flow if not provided.
    if (!Array.isArray(body.context_breakdown) || body.context_breakdown.length === 0) {
      body.context_breakdown = generateContextBreakdown(body);
    }

    // Send only Omni fields to avoid unknown-field issues.
    const omniPayload = {
      name: String(body.name).trim(),
      welcome_message: body.welcome_message,
      context_breakdown: body.context_breakdown,
    };

    const omniResult = await omniRequest("POST", "/agents/create", { data: omniPayload });
    const omniAgentId = pickOmniAgentId(omniResult);

    const integrationsText = JSON.stringify(body);
    const createdBy = req.user?.id ?? null;

    const [r] = await pool.query(
      `INSERT INTO voice_agents (name, description, external_id, integrations, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(body.name).trim(),
        body.description != null && body.description !== "" ? String(body.description).trim() : null,
        omniAgentId != null ? String(omniAgentId) : null,
        integrationsText,
        createdBy,
      ]
    );
    const [rows] = await pool.query("SELECT * FROM voice_agents WHERE id = ?", [r.insertId]);

    res.status(201).json({
      success: true,
      data: {
        omni: omniResult,
        agent: agentRowToObject(rows[0]),
      },
    });
  } catch (err) {
    console.error("Omni create agent error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

/**
 * GET /api/omni/admin/omnidim-agents (admin & viewer — read-only list)
 * Proxies OmniDimension GET /agents — all voice agents on the account (same as omnidim.io/agents).
 * Query: page | pageno (default 1), page_size | pagesize (default 10, max 100). Optional search if API supports it.
 */
async function listOmnidimAgentsForAdmin(req, res) {
  try {
    const pageno = Math.max(1, parseInt(req.query.pageno ?? req.query.page, 10) || 1);
    const pagesize = Math.min(100, Math.max(1, parseInt(req.query.pagesize ?? req.query.page_size, 10) || 10));
    const params = { pageno, pagesize };
    const search = req.query.search && String(req.query.search).trim();
    if (search) params.search = search;

    const raw = await omniRequest("GET", "/agents", { params });
    res.json({
      success: true,
      data: raw,
      pagination: {
        page: pageno,
        page_size: pagesize,
      },
    });
  } catch (err) {
    console.error("List Omnidim agents (admin) error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

/**
 * GET /api/omni/admin/agents/:agentId (admin only)
 * :agentId = Omnidim dashboard id (e.g. 149450).
 * Response matches list-agents shape: data is an array of one row + pagination
 * (id / created_* from voice_agents when present; name, welcome_message, flow from live Omnidim).
 * Each row in `data` includes `omni`: the raw JSON from Omnidim GET /agents/:id
 * (every field they return), alongside the normalized fields for forms.
 */
async function getOmnidimAgentForAdmin(req, res) {
  try {
    await ensureAgentsTable();
    const agentIdRaw = String(req.params.agentId || "").trim();
    if (!agentIdRaw) {
      return res.status(400).json({ success: false, message: "agentId is required (Omnidim agent id, e.g. 133843)." });
    }

    const raw = await omniRequest("GET", `/agents/${encodeURIComponent(agentIdRaw)}`);

    const [localRows] = await pool.query("SELECT * FROM voice_agents WHERE external_id = ? LIMIT 1", [agentIdRaw]);
    const localRow = localRows.length ? localRows[0] : null;

    const item = buildAdminOmnidimAgentDetailItem(agentIdRaw, raw, localRow);
    const enriched = enrichAdminAgentDetailForClient(item);
    const safeOmni = omitOmnidimSecretsForClient(raw);

    res.json({
      success: true,
      data: [{ ...enriched, omni: safeOmni }],
      pagination: {
        page: 1,
        page_size: 10,
        total: 1,
        totalPages: 1,
      },
    });
  } catch (err) {
    console.error("Get Omnidim agent (admin) error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

/**
 * PATCH | PUT /api/omni/admin/agents/:agentId (admin only)
 * :agentId = Omnidim agent id (e.g. 135636). Partial update on OmniDimension PUT /agents/:id.
 *
 * Body (all optional except you must send at least one):
 * - name
 * - welcome_message
 * - description
 * - context_breakdown — array of { title, body, is_enabled? } (Omni “flow” / instructions)
 * - contextBreakdown — camelCase alias for context_breakdown
 * - flow — alias for context_breakdown; omit either to leave existing flow unchanged on Omni
 * Flow items may use Omnidim keys: context_title, context_body (and optional id).
 * welcomeMessage — camelCase alias for welcome_message.
 */
async function updateOmnidimAgentForAdmin(req, res) {
  try {
    await ensureAgentsTable();
    const agentIdRaw = String(req.params.agentId || "").trim();
    if (!agentIdRaw) {
      return res.status(400).json({ success: false, message: "agentId is required (Omnidim agent id, e.g. 135636)." });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const payload = {};

    if (body.name != null && String(body.name).trim() !== "") {
      payload.name = String(body.name).trim();
    }
    const welcomeSrc = body.welcome_message !== undefined ? body.welcome_message : body.welcomeMessage;
    if (welcomeSrc != null) {
      payload.welcome_message = String(welcomeSrc).trim();
    }
    if (body.description != null) {
      payload.description = String(body.description).trim();
    }

    const flow =
      body.context_breakdown !== undefined
        ? body.context_breakdown
        : body.flow !== undefined
          ? body.flow
          : body.contextBreakdown;
    if (flow !== undefined) {
      if (!Array.isArray(flow)) {
        return res.status(400).json({
          success: false,
          message: "context_breakdown (or flow or contextBreakdown) must be an array when provided.",
        });
      }
      const normalized = [];
      for (let i = 0; i < flow.length; i++) {
        const row = normalizeIncomingFlowRow(flow[i]);
        if (!row) {
          return res.status(400).json({
            success: false,
            message: `Each flow item needs title/body or context_title/context_body (index ${i}).`,
          });
        }
        normalized.push(row);
      }
      let toSend = normalized;
      const needsIds = normalized.some((r) => !Number.isFinite(Number(r.id)));
      if (needsIds) {
        try {
          const liveRaw = await omniRequest("GET", `/agents/${encodeURIComponent(agentIdRaw)}`);
          const liveFlow = extractFlowArrayFromOmniAgentRaw(liveRaw);
          toSend = enrichFlowRowsWithLiveIds(normalized, liveFlow);
        } catch (liveErr) {
          console.warn(
            "Admin agent update: could not GET agent to merge flow step ids:",
            liveErr?.response?.data || liveErr?.message || liveErr
          );
        }
      }
      payload.context_breakdown = toSend.map(shapeFlowRowForOmniPut);
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Send at least one of: name, welcome_message (or welcomeMessage), description, context_breakdown (or flow or contextBreakdown).",
      });
    }

    const omniResult = await omniRequest("PUT", `/agents/${encodeURIComponent(agentIdRaw)}`, { data: payload });

    const [localRows] = await pool.query("SELECT * FROM voice_agents WHERE external_id = ? LIMIT 1", [agentIdRaw]);
    let agentOut = null;
    let localSyncError = null;
    if (localRows.length) {
      try {
        const row = localRows[0];
        const existingIntegrations = safeParseJson(row.integrations);
        const base =
          existingIntegrations && typeof existingIntegrations === "object" && !Array.isArray(existingIntegrations)
            ? existingIntegrations
            : {};

        const nextIntegrations = { ...base };
        if (payload.name != null) nextIntegrations.name = payload.name;
        if (payload.description != null) nextIntegrations.description = payload.description;
        if (payload.welcome_message != null) nextIntegrations.welcome_message = payload.welcome_message;
        if (payload.context_breakdown != null) nextIntegrations.context_breakdown = payload.context_breakdown;

        const newName = payload.name != null ? payload.name : row.name;
        const newDesc = payload.description != null ? payload.description : row.description;
        await pool.query(
          `UPDATE voice_agents SET name = ?, description = ?, integrations = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [newName, newDesc, JSON.stringify(nextIntegrations), row.id]
        );
        const [after] = await pool.query("SELECT * FROM voice_agents WHERE id = ?", [row.id]);
        agentOut = agentRowToObject(after[0]);
      } catch (dbErr) {
        console.error("Local voice_agents sync after Omnidim update:", dbErr);
        localSyncError = dbErr.message || String(dbErr);
      }
    }

    res.json({
      success: true,
      message: localSyncError
        ? "Agent updated on Omnidim; local cache sync failed (see local_sync_error)."
        : "Agent updated on Omnidim.",
      data: {
        omni: omniResult,
        ...(agentOut ? { agent: agentOut } : {}),
        ...(localSyncError ? { local_sync_error: localSyncError } : {}),
      },
    });
  } catch (err) {
    console.error("Admin update Omnidim agent error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

/**
 * DELETE /api/omni/admin/agents/:agentId (admin only)
 * :agentId = Omnidim dashboard id (e.g. 133843). Proxies Omni DELETE /agents/:id.
 */
async function deleteOmnidimAgentForAdmin(req, res) {
  try {
    await ensureAgentsTable();
    const agentIdRaw = String(req.params.agentId || "").trim();
    if (!agentIdRaw) {
      return res.status(400).json({ success: false, message: "agentId is required (Omnidim agent id)." });
    }

    const omniResult = await omniRequest("DELETE", `/agents/${encodeURIComponent(agentIdRaw)}`);

    await pool.query("DELETE FROM voice_agents WHERE external_id = ?", [agentIdRaw]).catch(() => {});

    res.json({ success: true, message: "Agent deleted on Omnidim.", data: { omni: omniResult } });
  } catch (err) {
    console.error("Admin delete Omnidim agent error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

/**
 * GET /api/omni/agents
 * Query: page | pageno (default 1), page_size | pagesize (default 30)
 * Omni SDK uses pageno + pagesize query params.
 */
async function listAgents(req, res) {
  try {
    await ensureAgentsTable();
    const createdBy = req.user?.id ?? null;
    const pageno = Math.max(1, parseInt(req.query.pageno ?? req.query.page, 10) || 1);
    const pagesize = Math.min(100, Math.max(1, parseInt(req.query.pagesize ?? req.query.page_size, 10) || 30));
    const offset = (pageno - 1) * pagesize;
    const search = req.query.search && String(req.query.search).trim();

    const where = ["va.created_by = ?"];
    const params = [createdBy];
    if (search) {
      where.push("(va.name LIKE ? OR va.external_id LIKE ?)");
      const term = `%${search}%`;
      params.push(term, term);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total FROM voice_agents va ${whereSql}`,
      params
    );
    const total = countRow.total;

    const [rows] = await pool.query(
      `SELECT * FROM voice_agents va ${whereSql} ORDER BY va.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, pagesize, offset]
    );

    res.json({
      success: true,
      data: rows.map(agentRowToObject),
      pagination: {
        page: pageno,
        page_size: pagesize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagesize)),
      },
    });
  } catch (err) {
    console.error("Omni list agents error:", err?.response?.data || err);
    res.status(500).json({ success: false, message: "Failed to list saved agents." });
  }
}

/**
 * GET /api/omni/agents/:agentId
 * Returns your saved row in `data`. When `external_id` is set, also fetches live agent from
 * Omnidim GET /agents/:id into `omni` (full detail). On Omni failure, `omni` is null and
 * `omni_error` may be set; local `data` is still returned.
 */
async function getAgent(req, res) {
  try {
    await ensureAgentsTable();
    const createdBy = req.user?.id ?? null;
    const raw = String(req.params.agentId || "").trim();
    if (!raw) return res.status(400).json({ success: false, message: "agentId is required." });
    const maybeLocalId = parseInt(raw, 10);
    const localId = Number.isFinite(maybeLocalId) ? maybeLocalId : null;

    const [rows] = await pool.query(
      `SELECT * FROM voice_agents
       WHERE created_by = ?
         AND (id = ? OR external_id = ?)
       LIMIT 1`,
      [createdBy, localId, raw]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Agent not found." });

    const data = agentRowToObject(rows[0]);
    const out = { success: true, data };
    const ext = data.external_id != null && String(data.external_id).trim() !== "" ? String(data.external_id).trim() : null;
    if (ext) {
      try {
        out.omni = await omniRequest("GET", `/agents/${encodeURIComponent(ext)}`);
      } catch (err) {
        console.error("Get agent Omni detail:", err?.response?.data || err);
        out.omni = null;
        const payload = err.response?.data;
        out.omni_error =
          payload?.error_description || payload?.message || payload?.error || err.message || "OmniDimension request failed.";
      }
    }
    res.json(out);
  } catch (err) {
    console.error("Get agent error:", err?.response?.data || err);
    res.status(500).json({ success: false, message: "Failed to get saved agent." });
  }
}

/**
 * PUT /api/omni/agents/:agentId
 * Body forwarded as JSON (fields to update per OmniDimension).
 */
async function updateAgent(req, res) {
  try {
    await ensureAgentsTable();
    const createdBy = req.user?.id ?? null;
    const agentIdRaw = String(req.params.agentId || "").trim();
    if (!agentIdRaw) return res.status(400).json({ success: false, message: "agentId is required." });

    const maybeLocalId = parseInt(agentIdRaw, 10);
    const localId = Number.isFinite(maybeLocalId) ? maybeLocalId : null;

    // If caller passed local DB id, map to Omni external_id for the Omni request.
    const [mapped] = await pool.query(
      `SELECT external_id
       FROM voice_agents
       WHERE created_by = ?
         AND (id = ? OR external_id = ?)
       LIMIT 1`,
      [createdBy, localId, agentIdRaw]
    );

    const omniExternalId =
      mapped && mapped.length && mapped[0].external_id != null ? String(mapped[0].external_id) : agentIdRaw;
    const agentIdForOmni = encodeURIComponent(omniExternalId);

    const body = req.body;
    if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, message: "JSON body with fields to update is required." });
    }

    const omniResult = await omniRequest("PUT", `/agents/${agentIdForOmni}`, { data: body });

    // Upsert locally by external_id (Omni agent id) for this admin/user
    const integrationsText = JSON.stringify(body);
    const nameVal = body.name != null ? String(body.name).trim() : null;
    const descVal = body.description != null && body.description !== "" ? String(body.description).trim() : null;

    const [existing] = await pool.query(
      "SELECT * FROM voice_agents WHERE created_by = ? AND external_id = ? LIMIT 1",
      [createdBy, omniExternalId]
    );

    if (existing.length) {
      const existingIntegrations = safeParseJson(existing[0].integrations) || {};
      // If frontend sends only changed fields, merge to preserve old sections.
      const mergedIntegrations = { ...existingIntegrations, ...body };
      const mergedIntegrationsText = JSON.stringify(mergedIntegrations);
      await pool.query(
        `UPDATE voice_agents
         SET name = COALESCE(?, name),
             description = COALESCE(?, description),
             integrations = ?
         WHERE id = ?`,
        [nameVal, descVal, mergedIntegrationsText, existing[0].id]
      );
    } else {
      if (!nameVal) {
        return res.status(400).json({
          success: false,
          message: "To create a saved agent for a new external_id, include body.name.",
        });
      }
      const [r] = await pool.query(
        `INSERT INTO voice_agents (name, description, external_id, integrations, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [nameVal, descVal, omniExternalId, integrationsText, createdBy]
      );
      const [rows] = await pool.query("SELECT * FROM voice_agents WHERE id = ?", [r.insertId]);
      return res.json({
        success: true,
        data: { omni: omniResult, agent: agentRowToObject(rows[0]) },
      });
    }

    const [rows] = await pool.query(
      "SELECT * FROM voice_agents WHERE created_by = ? AND external_id = ? LIMIT 1",
      [createdBy, omniExternalId]
    );
    res.json({ success: true, data: { omni: omniResult, agent: agentRowToObject(rows[0] || {}) } });
  } catch (err) {
    console.error("Omni update agent error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

/**
 * DELETE /api/omni/agents/:agentId
 */
async function deleteAgent(req, res) {
  try {
    await ensureAgentsTable();
    const createdBy = req.user?.id ?? null;
    const agentIdRaw = String(req.params.agentId || "").trim();
    const agentId = encodeURIComponent(agentIdRaw);
    if (!agentIdRaw) return res.status(400).json({ success: false, message: "agentId is required." });

    const maybeLocalId = parseInt(agentIdRaw, 10);
    const localId = Number.isFinite(maybeLocalId) ? maybeLocalId : null;

    const [mapped] = await pool.query(
      `SELECT external_id
       FROM voice_agents
       WHERE created_by = ?
         AND (id = ? OR external_id = ?)
       LIMIT 1`,
      [createdBy, localId, agentIdRaw]
    );

    const omniExternalId =
      mapped && mapped.length && mapped[0].external_id != null ? String(mapped[0].external_id) : agentIdRaw;

    const omniResult = await omniRequest("DELETE", `/agents/${encodeURIComponent(omniExternalId)}`);

    await pool.query(
      `DELETE FROM voice_agents
       WHERE created_by = ?
         AND (external_id = ? OR id = ?)`,
      [createdBy, omniExternalId, localId]
    );

    res.json({ success: true, data: { omni: omniResult } });
  } catch (err) {
    console.error("Omni delete agent error:", err?.response?.data || err);
    sendOmniError(res, err);
  }
}

module.exports = {
  createAgent,
  listAgents,
  listOmnidimAgentsForAdmin,
  getOmnidimAgentForAdmin,
  updateOmnidimAgentForAdmin,
  deleteOmnidimAgentForAdmin,
  getAgent,
  updateAgent,
  deleteAgent,
  ensureAgentsTable,
};
