const pool = require("../config/db");
const { dispatchOutboundCallCore, ensureOutboundCallRequestsTable } = require("../controllers/outboundCallsController");
const { ensureCampaignSchema } = require("../controllers/campaignsController");

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function parseSchedule(scheduleRaw) {
  if (scheduleRaw == null || scheduleRaw === "") return null;
  if (typeof scheduleRaw === "object") return scheduleRaw;
  try {
    return JSON.parse(scheduleRaw);
  } catch {
    return null;
  }
}

function formatYmdInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const o = {};
  for (const p of parts) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  if (!o.year || !o.month || !o.day) return null;
  return `${o.year}-${o.month}-${o.day}`;
}

function weekdayKeyInTz(date, timeZone) {
  const w = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return String(w || "")
    .slice(0, 3)
    .toLowerCase();
}

function parseTimeToMinutes(s) {
  const t = toOptionalString(s);
  if (!t) return null;
  const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    const ap = m12[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }
  const m24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

function nowMinutesInTz(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const o = {};
  for (const p of parts) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  const h = parseInt(o.hour, 10);
  const m = parseInt(o.minute, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function normalizeDayTokens(schedule) {
  const raw = schedule?.days ?? schedule?.days_to_run ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => String(d).trim().toLowerCase().slice(0, 3)).filter(Boolean);
}

function isWithinCampaignWindow(campaign, now = new Date()) {
  const tz = toOptionalString(campaign.timezone) || "Asia/Kolkata";
  const ymd = formatYmdInTz(now, tz);
  if (!ymd) return { ok: false, reason: "timezone" };

  if (campaign.start_date) {
    const sd = String(campaign.start_date).slice(0, 10);
    if (ymd < sd) return { ok: false, reason: "before_start" };
  }
  if (campaign.end_date) {
    const ed = String(campaign.end_date).slice(0, 10);
    if (ymd > ed) return { ok: false, reason: "after_end" };
  }

  const schedule = parseSchedule(campaign.schedule);
  if (!schedule || typeof schedule !== "object") {
    return { ok: true, reason: "no_schedule_restrictions" };
  }

  const days = normalizeDayTokens(schedule);
  if (days.length) {
    const wd = weekdayKeyInTz(now, tz);
    if (!days.includes(wd)) return { ok: false, reason: "wrong_weekday" };
  }

  const startM = parseTimeToMinutes(schedule.call_window_start ?? schedule.start);
  const endM = parseTimeToMinutes(schedule.call_window_end ?? schedule.end);
  if (startM == null || endM == null) {
    return { ok: true, reason: "no_time_window" };
  }

  const cur = nowMinutesInTz(now, tz);
  if (cur == null) return { ok: false, reason: "time_parse" };

  if (startM <= endM) {
    if (cur < startM || cur > endM) return { ok: false, reason: "outside_hours" };
  } else {
    if (cur < startM && cur > endM) return { ok: false, reason: "outside_hours" };
  }

  return { ok: true, reason: "ok" };
}

function leadDisplayName(row) {
  return (
    toOptionalString(row.owner_name) ||
    toOptionalString(row.hotel_name) ||
    toOptionalString(row.name) ||
    "Contact"
  );
}

let timer = null;
let running = false;

async function processCampaignRow(campaign) {
  const initiatorId = campaign.created_by;
  const voiceAgentId = campaign.voice_agent_id;
  if (!initiatorId || !voiceAgentId) return { skipped: true, reason: "missing_owner_or_agent" };

  let initiatorRole = null;
  const [[initiatorUser]] = await pool.query("SELECT role FROM users WHERE id = ?", [initiatorId]);
  if (initiatorUser) initiatorRole = initiatorUser.role;

  const freq = campaign.call_frequency != null && campaign.call_frequency !== "" ? parseInt(campaign.call_frequency, 10) : 1;
  const maxPerLead = Number.isFinite(freq) && freq > 0 ? freq : 1;

  const dialCheck = isWithinCampaignWindow(campaign);
  if (!dialCheck.ok) return { skipped: true, reason: dialCheck.reason };

  const maxPerTick = Math.min(
    Math.max(1, parseInt(process.env.CAMPAIGN_DIAL_MAX_PER_TICK || "2", 10) || 2),
    10
  );

  const [candidates] = await pool.query(
    `SELECT cl.id AS cl_id, cl.lead_id, cl.status,
            l.name, l.owner_name, l.hotel_name, l.phone
     FROM campaign_leads cl
     INNER JOIN leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = ?
       AND cl.status = 'pending'
       AND l.phone IS NOT NULL
       AND TRIM(l.phone) <> ''
     ORDER BY cl.id ASC
     LIMIT 25`,
    [campaign.id]
  );

  let placed = 0;
  const results = [];

  for (const row of candidates) {
    if (placed >= maxPerTick) break;

    const [[cntRow]] = await pool.query(
      `SELECT COUNT(*) AS c
       FROM outbound_call_requests
       WHERE campaign_id = ?
         AND lead_id = ?
         AND DATE(created_at) = CURDATE()`,
      [campaign.id, row.lead_id]
    );
    const todayCount = Number(cntRow?.c) || 0;
    if (todayCount >= maxPerLead) continue;

    const phone = toOptionalString(row.phone);
    const name = leadDisplayName(row);
    if (!phone) continue;

    const dispatch = await dispatchOutboundCallCore({
      initiatorUserId: initiatorId,
      initiatorRole,
      contactName: name,
      phone,
      voiceAgentId,
      campaignId: campaign.id,
      leadId: row.lead_id,
      fromNumberEnvFallback: true,
    });

    if (!dispatch.requestId) {
      results.push({ lead_id: row.lead_id, ok: false, message: dispatch.message });
      continue;
    }

    placed += 1;
    const [[cntAfter]] = await pool.query(
      `SELECT COUNT(*) AS c
       FROM outbound_call_requests
       WHERE campaign_id = ?
         AND lead_id = ?
         AND DATE(created_at) = CURDATE()`,
      [campaign.id, row.lead_id]
    );
    if (Number(cntAfter?.c) >= maxPerLead) {
      await pool.query(
        `UPDATE campaign_leads SET status = 'called', last_called_at = NOW() WHERE campaign_id = ? AND lead_id = ?`,
        [campaign.id, row.lead_id]
      );
    }
    results.push({
      lead_id: row.lead_id,
      ok: dispatch.ok,
      message: dispatch.message,
      request_id: dispatch.requestId,
    });
  }

  return { skipped: false, placed, results };
}

async function runTick() {
  if (running) return;
  running = true;
  try {
    if (process.env.CAMPAIGN_DIALER_ENABLED === "0" || process.env.CAMPAIGN_DIALER_ENABLED === "false") {
      return;
    }

    await ensureCampaignSchema();
    await ensureOutboundCallRequestsTable();

    const [rows] = await pool.query(
      `SELECT *
       FROM campaigns
       WHERE status = 'active'
         AND voice_agent_id IS NOT NULL
         AND created_by IS NOT NULL
       ORDER BY id ASC
       LIMIT 50`
    );

    for (const c of rows) {
      try {
        await processCampaignRow(c);
      } catch (e) {
        console.error("Campaign dialer row error:", c?.id, e?.message || e);
      }
    }
  } catch (e) {
    console.error("Campaign dialer tick error:", e?.message || e);
  } finally {
    running = false;
  }
}

function startCampaignDialer() {
  if (timer) return;
  const ms = Math.max(15000, parseInt(process.env.CAMPAIGN_DIAL_INTERVAL_MS || "60000", 10) || 60000);
  timer = setInterval(runTick, ms);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(runTick, 5000);
}

module.exports = { startCampaignDialer, runTick, isWithinCampaignWindow };
