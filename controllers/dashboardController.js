const pool = require("../config/db");

let campaignCreatedByChecked = false;
async function ensureCampaignCreatedBy() {
  if (campaignCreatedByChecked) return;
  try {
    await pool.query("ALTER TABLE campaigns ADD COLUMN created_by INT NULL");
  } catch (e) {
    const dup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
    if (!dup) throw e;
  }
  campaignCreatedByChecked = true;
}

let leadCreatedByChecked = false;
async function ensureLeadCreatedBy() {
  if (leadCreatedByChecked) return;
  try {
    await pool.query("ALTER TABLE leads ADD COLUMN created_by INT");
  } catch (e) {
    const dup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
    if (!dup) throw e;
  }
  leadCreatedByChecked = true;
}

async function scalar(query, params) {
  const [[row]] = await pool.query(query, params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function scalarSafe(query, params) {
  try {
    return await scalar(query, params);
  } catch {
    return 0;
  }
}

function buildCountsExplanation(role, scope) {
  if (role === "admin" && scope === "platform") {
    return {
      leads_total: "COUNT(*) FROM leads",
      leads_by_status: "GROUP BY leads.status (all rows)",
      campaigns_total: "COUNT(*) FROM campaigns",
      campaigns_active: "COUNT(*) FROM campaigns WHERE status = 'active'",
      payments_count: "COUNT(*) FROM payments",
      payments_completed_sum: "SUM(payments.amount) WHERE status = 'completed'",
      payments_pending_count: "COUNT(*) FROM payments WHERE status = 'pending'",
      calendar_entries: "COUNT(*) FROM calender",
      meetings_total: "COUNT(*) FROM meetings",
      meetings_scheduled: "COUNT(*) FROM meetings WHERE status = 'scheduled'",
      calls_logged: "COUNT(*) FROM calls",
      scripts_total: "COUNT(*) FROM scripts",
      users_total: "COUNT(*) FROM users",
    };
  }
  if (role === "agent" && scope === "assigned_and_own") {
    return {
      leads_total: "COUNT(*) FROM leads WHERE agent_id = you",
      leads_by_status: "GROUP BY status ON leads WHERE agent_id = you",
      campaigns_total: "COUNT(*) FROM campaigns WHERE created_by = you",
      campaigns_active: "COUNT(*) FROM campaigns WHERE created_by = you AND status = 'active'",
      payments_count: "COUNT(*) FROM payments WHERE user_id = you",
      payments_completed_sum: "SUM(amount) WHERE user_id = you AND status = 'completed'",
      payments_pending_count: "COUNT(*) WHERE user_id = you AND status = 'pending'",
      calendar_entries: "COUNT(*) FROM calender WHERE user_id = you",
      meetings_total: "COUNT(*) FROM meetings WHERE user_id = you",
      meetings_scheduled: "meetings WHERE user_id = you AND status = 'scheduled'",
      calls_logged: "COUNT(*) FROM calls JOIN leads ON lead_id WHERE leads.agent_id = you",
      scripts_total: "COUNT(*) FROM scripts (global)",
      users_total: "N/A for agents (always 0)",
    };
  }
  return null;
}

function buildKpiBreakdown(role, scope, counts, rates) {
  const isPlatform = role === "admin" && scope === "platform";
  const desc = (d) => ({ value: d.v, how: d.h });
  return {
    calls_made: desc({
      v: counts.calls_logged,
      h: isPlatform
        ? "COUNT(*) FROM calls (entire workspace)"
        : "COUNT(*) FROM calls INNER JOIN leads WHERE lead.agent_id = you (agent)",
    }),
    revenue: desc({
      v: counts.payments_completed_sum,
      h: isPlatform
        ? "SUM(payments.amount) WHERE status = 'completed' (all users)"
        : "SUM(payments.amount) WHERE status = 'completed' AND payments.user_id = you",
    }),
    meetings: desc({
      v: counts.meetings_total,
      h: isPlatform ? "COUNT(*) FROM meetings (all users)" : "COUNT(*) FROM meetings WHERE user_id = you",
    }),
    conversion_rate: desc({
      v: rates.conversion_percent,
      h: isPlatform
        ? "(leads with status converted ÷ all leads) × 100"
        : "(converted ÷ your scoped leads) × 100 — see scope",
    }),
    active_campaigns: desc({
      v: counts.campaigns_active,
      h: isPlatform
        ? "COUNT(*) FROM campaigns WHERE status = 'active' (workspace)"
        : "COUNT(*) FROM campaigns WHERE created_by = you AND status = 'active'",
    }),
  };
}

/**
 * GET /api/dashboard/stats
 * Admin: platform-wide totals. Agent: assigned leads + own campaigns. Viewer: zeros.
 */
const getStats = async (req, res) => {
  try {
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, message: "Please log in again." });
    }

    await ensureLeadCreatedBy();
    await ensureCampaignCreatedBy();

    const uid = user.id;
    const role = String(user.role || "viewer");

    const empty = {
      role,
      user: { id: user.id, name: user.name, email: user.email, role },
      scope: "none",
      counts: {
        leads_total: 0,
        leads_by_status: { new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 },
        campaigns_total: 0,
        campaigns_active: 0,
        payments_count: 0,
        payments_completed_sum: 0,
        payments_pending_count: 0,
        calendar_entries: 0,
        meetings_total: 0,
        meetings_scheduled: 0,
        calls_logged: 0,
        scripts_total: 0,
        users_total: 0,
      },
      rates: { conversion_percent: 0 },
      flags: { google_calendar_connected: false },
    };

    /** Flat KPI keys — same names as the original dummy `/dashboard/stats` so older frontends still work. */
    const flatKpis = (c, r) => ({
      calls_made: c.calls_logged,
      conversion_rate: r.conversion_percent,
      revenue: c.payments_completed_sum,
      meetings: c.meetings_total,
      active_campaigns: c.campaigns_active,
    });

    if (role === "viewer") {
      return res.json({
        success: true,
        data: {
          ...flatKpis(empty.counts, empty.rates),
          ...empty,
        },
      });
    }

    let scope = "own";
    const counts = {
      ...empty.counts,
      leads_by_status: { ...empty.counts.leads_by_status },
    };

    if (role === "admin") {
      scope = "platform";
      counts.leads_total = await scalar("SELECT COUNT(*) AS c FROM leads", []);
      const statusRows = await pool
        .query(`SELECT status, COUNT(*) AS c FROM leads GROUP BY status`)
        .then(([rows]) => rows);
      for (const r of statusRows || []) {
        const k = String(r.status || "").toLowerCase();
        if (counts.leads_by_status[k] !== undefined) counts.leads_by_status[k] = Number(r.c) || 0;
      }
      counts.campaigns_total = await scalar("SELECT COUNT(*) AS c FROM campaigns", []);
      counts.campaigns_active = await scalar(
        "SELECT COUNT(*) AS c FROM campaigns WHERE status = 'active'",
        []
      );
      counts.calls_logged = await scalar("SELECT COUNT(*) AS c FROM calls", []);
      counts.users_total = await scalarSafe("SELECT COUNT(*) AS c FROM users", []);

      counts.payments_count = await scalarSafe("SELECT COUNT(*) AS c FROM payments", []);
      counts.payments_pending_count = await scalarSafe(
        "SELECT COUNT(*) AS c FROM payments WHERE status = 'pending'",
        []
      );
      let payCompleted = 0;
      try {
        const [[paySum]] = await pool.query(
          "SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE status = 'completed'",
          []
        );
        payCompleted = paySum && paySum.s != null ? Number(paySum.s) : 0;
      } catch {
        payCompleted = 0;
      }
      counts.payments_completed_sum = payCompleted;

      counts.calendar_entries = await scalarSafe("SELECT COUNT(*) AS c FROM calender", []);
      counts.meetings_total = await scalarSafe("SELECT COUNT(*) AS c FROM meetings", []);
      counts.meetings_scheduled = await scalarSafe(
        "SELECT COUNT(*) AS c FROM meetings WHERE status = 'scheduled'",
        []
      );
      counts.scripts_total = await scalarSafe("SELECT COUNT(*) AS c FROM scripts", []);
    } else if (role === "agent") {
      scope = "assigned_and_own";
      counts.leads_total = await scalar("SELECT COUNT(*) AS c FROM leads WHERE agent_id = ?", [uid]);
      const statusRows = await pool
        .query(`SELECT status, COUNT(*) AS c FROM leads WHERE agent_id = ? GROUP BY status`, [uid])
        .then(([rows]) => rows);
      for (const r of statusRows || []) {
        const k = String(r.status || "").toLowerCase();
        if (counts.leads_by_status[k] !== undefined) counts.leads_by_status[k] = Number(r.c) || 0;
      }
      counts.campaigns_total = await scalar("SELECT COUNT(*) AS c FROM campaigns WHERE created_by = ?", [uid]);
      counts.campaigns_active = await scalar(
        "SELECT COUNT(*) AS c FROM campaigns WHERE created_by = ? AND status = 'active'",
        [uid]
      );
      counts.calls_logged = await scalar(
        `SELECT COUNT(*) AS c FROM calls c
         INNER JOIN leads l ON l.id = c.lead_id
         WHERE l.agent_id = ?`,
        [uid]
      );
      counts.users_total = 0;

      counts.payments_count = await scalarSafe("SELECT COUNT(*) AS c FROM payments WHERE user_id = ?", [uid]);
      counts.payments_pending_count = await scalarSafe(
        "SELECT COUNT(*) AS c FROM payments WHERE user_id = ? AND status = 'pending'",
        [uid]
      );
      let payCompleted = 0;
      try {
        const [[paySum]] = await pool.query(
          "SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE user_id = ? AND status = 'completed'",
          [uid]
        );
        payCompleted = paySum && paySum.s != null ? Number(paySum.s) : 0;
      } catch {
        payCompleted = 0;
      }
      counts.payments_completed_sum = payCompleted;

      counts.calendar_entries = await scalarSafe(
        "SELECT COUNT(*) AS c FROM calender WHERE user_id = ?",
        [uid]
      );

      counts.meetings_total = await scalarSafe("SELECT COUNT(*) AS c FROM meetings WHERE user_id = ?", [uid]);
      counts.meetings_scheduled = await scalarSafe(
        "SELECT COUNT(*) AS c FROM meetings WHERE user_id = ? AND status = 'scheduled'",
        [uid]
      );

      counts.scripts_total = await scalarSafe("SELECT COUNT(*) AS c FROM scripts", []);
    } else {
      return res.json({
        success: true,
        data: {
          ...flatKpis(empty.counts, empty.rates),
          ...empty,
        },
      });
    }

    // Lead conversion: % of leads in status "converted" within the same scope as counts.leads_total
    const conv =
      counts.leads_total > 0 ? (counts.leads_by_status.converted / counts.leads_total) * 100 : 0;
    const rates = { conversion_percent: Math.round(conv * 10) / 10 };

    const gcRows = await pool
      .query("SELECT 1 AS ok FROM user_google_calendar WHERE user_id = ? LIMIT 1", [uid])
      .then(([r]) => r)
      .catch(() => []);

    res.json({
      success: true,
      data: {
        // Legacy flat KPIs (dashboard cards)
        ...flatKpis(counts, rates),
        role,
        user: { id: user.id, name: user.name, email: user.email, role },
        scope,
        scope_help:
          scope === "platform"
            ? "Admin metrics count the entire workspace (all users), not only rows where created_by = you."
            : scope === "assigned_and_own"
              ? "Agent metrics: leads assigned to you; campaigns you created; payments linked to your user_id."
              : scope,
        counts,
        counts_explanation: buildCountsExplanation(role, scope),
        rates,
        kpi_breakdown: buildKpiBreakdown(role, scope, counts, rates),
        flags: { google_calendar_connected: Array.isArray(gcRows) && gcRows.length > 0 },
      },
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ success: false, message: "Could not load dashboard stats." });
  }
};

/**
 * GET /api/calls/recent — admin: latest calls workspace-wide. Agent: calls for assigned leads only.
 */
const getRecentCalls = async (req, res) => {
  try {
    const uid = req.user?.id;
    const role = String(req.user?.role || "viewer");
    if (!uid) {
      return res.status(401).json({ success: false, message: "Please log in again." });
    }
    if (role === "viewer") {
      return res.json({ success: true, data: [] });
    }

    const isAdmin = role === "admin";
    const sql = isAdmin
      ? `SELECT c.id, c.lead_id, c.campaign_id,
        COALESCE(NULLIF(TRIM(l.hotel_name), ''), NULLIF(TRIM(l.owner_name), ''), l.name) AS name,
        l.phone,
        COALESCE(c.outcome, c.status) AS outcome,
        c.created_at
       FROM calls c
       LEFT JOIN leads l ON l.id = c.lead_id
       ORDER BY c.created_at DESC
       LIMIT 25`
      : `SELECT c.id, c.lead_id, c.campaign_id,
        COALESCE(NULLIF(TRIM(l.hotel_name), ''), NULLIF(TRIM(l.owner_name), ''), l.name) AS name,
        l.phone,
        COALESCE(c.outcome, c.status) AS outcome,
        c.created_at
       FROM calls c
       INNER JOIN leads l ON l.id = c.lead_id
       WHERE l.agent_id = ?
       ORDER BY c.created_at DESC
       LIMIT 25`;

    const [rows] = await pool.query(sql, isAdmin ? [] : [uid]);

    const data = (rows || []).map((r) => ({
      id: r.id,
      lead_id: r.lead_id,
      campaign_id: r.campaign_id,
      name: r.name || null,
      phone: r.phone || null,
      outcome: r.outcome || null,
      created_at: r.created_at,
    }));

    res.json({
      success: true,
      scope: isAdmin ? "platform" : "assigned_leads",
      data,
    });
  } catch (err) {
    console.error("Recent calls error:", err);
    res.status(500).json({ success: false, message: "Could not load recent calls." });
  }
};

const getRevenue = async (req, res) => {
  try {
    const uid = req.user?.id;
    const role = String(req.user?.role || "viewer");
    if (!uid) {
      return res.status(401).json({ success: false, message: "Please log in again." });
    }

    const emptyCharts = {
      revenue: 0,
      currency: "INR",
      transaction_count: 0,
      revenue_per_month: [],
      calls_per_month: [],
      conversion_per_month: [],
      conversion_rate: 0,
    };

    if (role === "viewer") {
      return res.json({ success: true, data: emptyCharts });
    }

    const isPlatformAdmin = role === "admin";

    const [revRows] = await pool
      .query(
        isPlatformAdmin
          ? `SELECT DATE_FORMAT(created_at, '%b %Y') AS month, SUM(amount) AS revenue
             FROM payments
             WHERE status = 'completed' AND created_at >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
             GROUP BY YEAR(created_at), MONTH(created_at), month
             ORDER BY YEAR(created_at), MONTH(created_at)`
          : `SELECT DATE_FORMAT(created_at, '%b %Y') AS month, SUM(amount) AS revenue
             FROM payments
             WHERE user_id = ? AND status = 'completed' AND created_at >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
             GROUP BY YEAR(created_at), MONTH(created_at), month
             ORDER BY YEAR(created_at), MONTH(created_at)`,
        isPlatformAdmin ? [] : [uid]
      )
      .catch(() => [[], []]);

    const [callRows] = await pool
      .query(
        isPlatformAdmin
          ? `SELECT DATE_FORMAT(c.created_at, '%b %Y') AS month, COUNT(*) AS calls
             FROM calls c
             WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
             GROUP BY YEAR(c.created_at), MONTH(c.created_at), month
             ORDER BY YEAR(c.created_at), MONTH(c.created_at)`
          : `SELECT DATE_FORMAT(c.created_at, '%b %Y') AS month, COUNT(*) AS calls
             FROM calls c
             INNER JOIN leads l ON l.id = c.lead_id
             WHERE l.agent_id = ? AND c.created_at >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
             GROUP BY YEAR(c.created_at), MONTH(c.created_at), month
             ORDER BY YEAR(c.created_at), MONTH(c.created_at)`,
        isPlatformAdmin ? [] : [uid]
      )
      .catch(() => [[], []]);

    const convSql = isPlatformAdmin
      ? `SELECT DATE_FORMAT(created_at, '%b %Y') AS month,
          ROUND(SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS rate
          FROM leads
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
          GROUP BY YEAR(created_at), MONTH(created_at), month
          ORDER BY YEAR(created_at), MONTH(created_at)`
      : `SELECT DATE_FORMAT(created_at, '%b %Y') AS month,
          ROUND(SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS rate
          FROM leads
          WHERE agent_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
          GROUP BY YEAR(created_at), MONTH(created_at), month
          ORDER BY YEAR(created_at), MONTH(created_at)`;

    const [convRows] = await pool.query(convSql, isPlatformAdmin ? [] : [uid]).catch(() => [[], []]);

    const revenue_per_month = (revRows || []).map((r) => ({
      month: r.month,
      revenue: Number(r.revenue) || 0,
    }));
    const calls_per_month = (callRows || []).map((r) => ({
      month: r.month,
      calls: Number(r.calls) || 0,
    }));
    const conversion_per_month = (convRows || []).map((r) => ({
      month: r.month,
      rate: r.rate != null ? Number(r.rate) : 0,
    }));

    const revenue = revenue_per_month.reduce((s, m) => s + m.revenue, 0);
    const [[tcRow]] = await pool
      .query(
        isPlatformAdmin
          ? "SELECT COUNT(*) AS c FROM payments WHERE status = 'completed'"
          : "SELECT COUNT(*) AS c FROM payments WHERE user_id = ? AND status = 'completed'",
        isPlatformAdmin ? [] : [uid]
      )
      .catch(() => [[{ c: 0 }]]);

    let conversion_rate = 0;
    try {
      const [[ls]] = await pool.query(
        isPlatformAdmin
          ? "SELECT COUNT(*) AS t, SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS cv FROM leads"
          : "SELECT COUNT(*) AS t, SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS cv FROM leads WHERE agent_id = ?",
        isPlatformAdmin ? [] : [uid]
      );
      const t = Number(ls?.t) || 0;
      const cv = Number(ls?.cv) || 0;
      conversion_rate = t > 0 ? Math.round((cv / t) * 1000) / 10 : 0;
    } catch {
      conversion_rate = 0;
    }

    res.json({
      success: true,
      data: {
        revenue,
        currency: "INR",
        transaction_count: Number(tcRow?.c) || 0,
        revenue_per_month,
        calls_per_month,
        conversion_per_month,
        conversion_rate,
        scope: isPlatformAdmin ? "platform" : "agent_self",
        scope_help: isPlatformAdmin
          ? "Charts aggregate all payments, calls, and leads in the database (admin workspace view)."
          : "Charts use payments.user_id = you and leads.agent_id = you.",
      },
    });
  } catch (err) {
    console.error("Revenue dashboard error:", err);
    res.status(500).json({ success: false, message: "Could not load revenue data." });
  }
};

module.exports = {
  getStats,
  getRecentCalls,
  getRevenue,
};
