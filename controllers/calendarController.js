const { google } = require("googleapis");
const pool = require("../config/db");

const CALENDAR_SCOPE = ["https://www.googleapis.com/auth/calendar"];

let tableChecked = false;
async function ensureCalendarCredentialsTable() {
  if (tableChecked) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS user_google_calendar (
      user_id INT PRIMARY KEY,
      refresh_token TEXT,
      access_token TEXT,
      token_expiry_ms BIGINT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  tableChecked = true;
}

function getOAuth2Client() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI in .env");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * GET /api/calendar/oauth/config-debug (Bearer JWT)
 * Shows exact redirect_uri your server uses — paste this into Google Console (must match 100%).
 */
async function oauthConfigDebug(req, res) {
  try {
    const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
    const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
    res.json({
      success: true,
      data: {
        client_id: clientId || null,
        redirect_uri: redirectUri || null,
        instructions:
          "In Google Cloud → APIs & Services → Credentials → open THIS client_id → Authorised redirect URIs → add redirect_uri exactly (no trailing slash unless it is here).",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getAuthForUser(userId) {
  await ensureCalendarCredentialsTable();
  const [rows] = await pool.query("SELECT refresh_token, access_token, token_expiry_ms FROM user_google_calendar WHERE user_id = ?", [userId]);
  if (!rows.length || !rows[0].refresh_token) {
    const err = new Error("LINK_GOOGLE_CALENDAR");
    err.code = "LINK_GOOGLE_CALENDAR";
    throw err;
  }
  const oAuth2Client = getOAuth2Client();
  oAuth2Client.setCredentials({
    refresh_token: rows[0].refresh_token,
    access_token: rows[0].access_token || undefined,
    expiry_date: rows[0].token_expiry_ms != null ? Number(rows[0].token_expiry_ms) : undefined,
  });
  oAuth2Client.on("tokens", async (t) => {
    try {
      await pool.query(
        "UPDATE user_google_calendar SET access_token = ?, token_expiry_ms = ? WHERE user_id = ?",
        [t.access_token || null, t.expiry_date != null ? t.expiry_date : null, userId]
      );
    } catch (_) {
      /* ignore */
    }
  });
  return oAuth2Client;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * GET /api/calendar/oauth/google-callback?code=...&error=...
 * Public page so Google redirects here (set GOOGLE_REDIRECT_URI to this URL).
 * Shows the code to copy into Postman — avoids frontend /login stripping ?code=
 */
async function oauthGoogleCallback(req, res) {
  const error = req.query.error;
  const code = req.query.code;
  if (error) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;"><h1>Google error</h1><p>${escapeHtml(error)}</p></body></html>`
    );
  }
  if (!code) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;"><h1>No code</h1><p>Google did not return a code. Check redirect URI in Google Cloud matches your .env exactly.</p></body></html>`
    );
  }
  const safeCode = escapeHtml(code);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Copy code — Google Calendar</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:20px;">
  <h1>Step 2 — Copy this code</h1>
  <p>Google linked you here. Copy everything in the box below.</p>
  <textarea readonly style="width:100%;height:100px;font-size:13px;padding:8px;">${safeCode}</textarea>
  <h2>Step 3 — Postman</h2>
  <ol>
    <li><strong>POST</strong> <code>http://localhost:8000/api/calendar/oauth/token</code></li>
    <li><strong>Authorization</strong> → Bearer Token → same JWT you used for “oauth/url”</li>
    <li><strong>Body</strong> → raw → JSON:<br><pre style="background:#f5f5f5;padding:12px;">{ "code": "paste the code here" }</pre></li>
  </ol>
  <p>Then try <strong>GET /api/calendar/availability</strong> again.</p>
</body></html>`);
}

/**
 * GET /api/calendar/oauth/url
 */
async function oauthUrl(req, res) {
  try {
    const oAuth2Client = getOAuth2Client();
    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: CALENDAR_SCOPE,
    });
    res.json({ success: true, data: { url } });
  } catch (err) {
    console.error("Calendar oauth url error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to build OAuth URL." });
  }
}

/**
 * POST /api/calendar/oauth/token
 * Body: { code }
 */
async function oauthToken(req, res) {
  try {
    await ensureCalendarCredentialsTable();
    const code = req.body?.code;
    if (!code || typeof code !== "string") {
      return res.status(400).json({ success: false, message: "code is required." });
    }
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code.trim());
    if (!tokens.refresh_token && !tokens.access_token) {
      return res.status(400).json({
        success: false,
        message: "No tokens returned. Open GET /api/calendar/oauth/url again (use consent) and use a fresh code.",
      });
    }
    const userId = req.user.id;
    await pool.query(
      `INSERT INTO user_google_calendar (user_id, refresh_token, access_token, token_expiry_ms)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         refresh_token = IF(VALUES(refresh_token) IS NOT NULL AND VALUES(refresh_token) != '', VALUES(refresh_token), refresh_token),
         access_token = VALUES(access_token),
         token_expiry_ms = VALUES(token_expiry_ms)`,
      [
        userId,
        tokens.refresh_token || null,
        tokens.access_token || null,
        tokens.expiry_date != null ? tokens.expiry_date : null,
      ]
    );
    res.json({ success: true, message: "Google Calendar linked." });
  } catch (err) {
    console.error("Calendar oauth token error:", err);
    res.status(500).json({ success: false, message: "Failed to exchange OAuth code." });
  }
}

function calendarIdFromQuery(req) {
  return req.query.calendarId && String(req.query.calendarId).trim() ? String(req.query.calendarId).trim() : "primary";
}

/**
 * In query strings, "+" is decoded as space — breaks offsets like +05:30.
 * Fix "2026-03-20T00:00:00 05:30" -> "2026-03-20T00:00:00+05:30"
 */
function fixQueryDateTime(v) {
  if (v == null) return v;
  let s = String(v).trim();
  if (!s) return s;
  if (/T[\d:]+\s+\d{2}:\d{2}$/.test(s)) {
    s = s.replace(/\s+(\d{2}:\d{2})$/, "+$1");
  }
  return s;
}

/**
 * GET /api/calendar/availability?timeMin=ISO&timeMax=ISO&calendarId=primary
 */
async function availability(req, res) {
  try {
    let timeMin = fixQueryDateTime(req.query.timeMin);
    let timeMax = fixQueryDateTime(req.query.timeMax);
    if (!timeMin || !timeMax) {
      return res.status(400).json({ success: false, message: "timeMin and timeMax are required (ISO 8601)." });
    }
    const calendarId = calendarIdFromQuery(req);
    const auth = await getAuthForUser(req.user.id);
    const calendar = google.calendar({ version: "v3", auth });
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: calendarId }],
      },
    });
    res.json({ success: true, data: fb.data });
  } catch (err) {
    if (err.code === "LINK_GOOGLE_CALENDAR") {
      return res.status(400).json({
        success: false,
        message: "Link Google Calendar first: GET /api/calendar/oauth/url then POST /api/calendar/oauth/token with the code.",
      });
    }
    const gErr = err.response?.data?.error || err.errors?.[0] || err.message;
    console.error("Calendar availability error:", err.response?.data || err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch availability.",
      details: typeof gErr === "object" ? gErr : String(gErr),
    });
  }
}

/**
 * POST /api/calendar/book
 * Body: { summary, description?, start, end, calendarId?, attendees?: [{email}] }
 * start/end: Google Calendar API format, e.g. { dateTime: "2026-03-20T10:00:00+05:30", timeZone: "Asia/Kolkata" }
 */
async function book(req, res) {
  try {
    const { summary, description, start, end, attendees } = req.body || {};
    if (!summary || !start || !end) {
      return res.status(400).json({ success: false, message: "summary, start, and end are required." });
    }
    const calendarId = req.body?.calendarId && String(req.body.calendarId).trim() ? String(req.body.calendarId).trim() : "primary";
    const event = {
      summary: String(summary),
      ...(description != null ? { description: String(description) } : {}),
      start,
      end,
    };
    if (Array.isArray(attendees) && attendees.length) {
      event.attendees = attendees.map((a) => ({ email: a.email })).filter((a) => a.email);
    }
    const auth = await getAuthForUser(req.user.id);
    const calendar = google.calendar({ version: "v3", auth });
    const created = await calendar.events.insert({
      calendarId,
      requestBody: event,
      sendUpdates: event.attendees?.length ? "all" : "none",
    });
    res.status(201).json({ success: true, data: created.data });
  } catch (err) {
    if (err.code === "LINK_GOOGLE_CALENDAR") {
      return res.status(400).json({
        success: false,
        message: "Link Google Calendar first: GET /api/calendar/oauth/url then POST /api/calendar/oauth/token with the code.",
      });
    }
    console.error("Calendar book error:", err);
    res.status(500).json({ success: false, message: "Failed to create event." });
  }
}

/**
 * PUT /api/calendar/reschedule/:eventId
 * Body: { start, end, calendarId? }
 */
async function reschedule(req, res) {
  try {
    const eventId = req.params.eventId;
    if (!eventId) return res.status(400).json({ success: false, message: "eventId is required." });
    const { start, end } = req.body || {};
    if (!start || !end) {
      return res.status(400).json({ success: false, message: "start and end are required." });
    }
    const calendarId = req.body?.calendarId && String(req.body.calendarId).trim() ? String(req.body.calendarId).trim() : "primary";
    const auth = await getAuthForUser(req.user.id);
    const calendar = google.calendar({ version: "v3", auth });
    const updated = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: { start, end },
    });
    res.json({ success: true, data: updated.data });
  } catch (err) {
    if (err.code === "LINK_GOOGLE_CALENDAR") {
      return res.status(400).json({
        success: false,
        message: "Link Google Calendar first: GET /api/calendar/oauth/url then POST /api/calendar/oauth/token with the code.",
      });
    }
    console.error("Calendar reschedule error:", err);
    res.status(500).json({ success: false, message: "Failed to reschedule event." });
  }
}

/**
 * DELETE /api/calendar/cancel/:eventId?calendarId=primary
 */
async function cancel(req, res) {
  try {
    const eventId = req.params.eventId;
    if (!eventId) return res.status(400).json({ success: false, message: "eventId is required." });
    const calendarId = calendarIdFromQuery(req);
    const auth = await getAuthForUser(req.user.id);
    const calendar = google.calendar({ version: "v3", auth });
    await calendar.events.delete({ calendarId, eventId });
    res.json({ success: true, message: "Event cancelled (deleted)." });
  } catch (err) {
    if (err.code === "LINK_GOOGLE_CALENDAR") {
      return res.status(400).json({
        success: false,
        message: "Link Google Calendar first: GET /api/calendar/oauth/url then POST /api/calendar/oauth/token with the code.",
      });
    }
    console.error("Calendar cancel error:", err);
    res.status(500).json({ success: false, message: "Failed to cancel event." });
  }
}

module.exports = {
  oauthGoogleCallback,
  oauthConfigDebug,
  oauthUrl,
  oauthToken,
  availability,
  book,
  reschedule,
  cancel,
};
