const pool = require("../config/db");
const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");
const { sendSms } = require("../utils/sms");

let paymentsColumnsChecked = false;
async function ensurePaymentColumns() {
  if (paymentsColumnsChecked) return;

  const alters = [
    "ALTER TABLE payments ADD COLUMN razorpay_payment_link_id VARCHAR(100) NULL",
    "ALTER TABLE payments ADD COLUMN razorpay_short_url TEXT NULL",
    "ALTER TABLE payments ADD COLUMN razorpay_status VARCHAR(50) NULL",
    "ALTER TABLE payments ADD COLUMN customer_name VARCHAR(255) NULL",
    "ALTER TABLE payments ADD COLUMN customer_email VARCHAR(255) NULL",
    "ALTER TABLE payments ADD COLUMN customer_phone VARCHAR(50) NULL",
    "ALTER TABLE payments ADD COLUMN lead_id INT NULL",
    "ALTER TABLE payments ADD COLUMN invoice_path TEXT NULL",
  ];

  for (const sql of alters) {
    try {
      await pool.query(sql);
    } catch (e) {
      const isDup = e.code === "ER_DUP_FIELDNAME" || e.errno === 1060;
      if (!isDup) throw e;
    }
  }

  // FK is optional; ignore if it fails (older DB engines/constraints)
  try {
    await pool.query("ALTER TABLE payments ADD CONSTRAINT fk_payments_lead_id FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL");
  } catch (e) {
    // ignore duplicate constraint / engine limitations
  }

  paymentsColumnsChecked = true;
}

function getRazorpayAuth() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return {
    username: String(keyId).trim(),
    password: String(keySecret).trim(),
  };
}

function toMoney(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

async function writeInvoiceFile(paymentId, invoiceObj) {
  const dir = path.join(__dirname, "..", "storage", "invoices");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `invoice_${paymentId}.json`);
  await fs.writeFile(filePath, JSON.stringify(invoiceObj, null, 2), "utf8");
  return filePath;
}

/**
 * POST /api/payment/link
 * Body: { amount, currency?, description?, customer?: { name?, email?, contact? }, lead_id? }
 *
 * Creates a Razorpay payment link and stores it in DB.
 */
async function createPaymentLink(req, res) {
  try {
    await ensurePaymentColumns();

    const auth = getRazorpayAuth();
    if (!auth) {
      return res.status(500).json({ success: false, message: "Razorpay is not configured (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)." });
    }

    const body = req.body || {};
    const amount = toMoney(body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "amount is required and must be > 0." });
    }
    const currency = toOptionalString(body.currency) || "INR";
    const description = toOptionalString(body.description) || "Payment";

    const customer = body.customer || {};
    const customer_name = toOptionalString(customer.name);
    const customer_email = toOptionalString(customer.email);
    const customer_phone = toOptionalString(customer.contact || customer.phone);
    const lead_id = body.lead_id != null && body.lead_id !== "" ? parseInt(body.lead_id, 10) : null;

    const userId = req.user?.userId || null;
    const reference = `pay_${Date.now()}`;

    // Store pending record first
    const [r] = await pool.query(
      `INSERT INTO payments (user_id, amount, currency, status, payment_method, reference, customer_name, customer_email, customer_phone, lead_id)
       VALUES (?, ?, ?, 'pending', 'razorpay', ?, ?, ?, ?, ?)`,
      [userId, amount, currency, reference, customer_name, customer_email, customer_phone, Number.isFinite(lead_id) ? lead_id : null]
    );
    const paymentId = r.insertId;

    // Create payment link on Razorpay (amount in paise)
    const payload = {
      amount: Math.round(amount * 100),
      currency,
      description,
      reference_id: String(paymentId),
      customer: {
        name: customer_name || undefined,
        email: customer_email || undefined,
        contact: customer_phone || undefined,
      },
      notes: {
        local_payment_id: String(paymentId),
        reference,
      },
      notify: {
        sms: false,
        email: false,
      },
      reminder_enable: false,
    };

    const rp = await axios.post("https://api.razorpay.com/v1/payment_links", payload, {
      auth,
      timeout: 20000,
    });

    const link = rp.data;
    const linkId = link.id || null;
    const shortUrl = link.short_url || link.shorturl || link.shortUrl || null;
    const rpStatus = link.status || null;

    await pool.query(
      `UPDATE payments SET razorpay_payment_link_id = ?, razorpay_short_url = ?, razorpay_status = ? WHERE id = ?`,
      [linkId, shortUrl, rpStatus, paymentId]
    );

    // Invoice storage (simple JSON invoice)
    const invoiceObj = {
      payment_id: paymentId,
      provider: "razorpay",
      razorpay_payment_link_id: linkId,
      amount,
      currency,
      description,
      customer: { name: customer_name, email: customer_email, phone: customer_phone },
      created_at: new Date().toISOString(),
    };
    const invoicePath = await writeInvoiceFile(paymentId, invoiceObj);
    await pool.query("UPDATE payments SET invoice_path = ? WHERE id = ?", [invoicePath, paymentId]);

    // Optional SMS send
    let sms = { sent: false, reason: "not_requested" };
    const sendSmsFlag = body.send_sms === true || body.send_sms === "true";
    if (sendSmsFlag && customer_phone && shortUrl) {
      const msg = `Payment link: ${shortUrl}`;
      try {
        sms = await sendSms(customer_phone, msg);
      } catch (e) {
        sms = { sent: false, reason: "sms_failed" };
      }
    }

    const [saved] = await pool.query("SELECT * FROM payments WHERE id = ?", [paymentId]);
    res.status(201).json({
      success: true,
      data: {
        payment: saved[0],
        payment_link: { id: linkId, short_url: shortUrl, status: rpStatus },
        sms,
      },
    });
  } catch (err) {
    console.error("Create payment link error:", err?.response?.data || err);
    res.status(500).json({ success: false, message: "Failed to create payment link." });
  }
}

/**
 * GET /api/payment/status?id=<localPaymentId> OR ?payment_link_id=<razorpayPaymentLinkId>
 *
 * Fetches latest status from Razorpay and updates DB.
 */
async function getPaymentStatus(req, res) {
  try {
    await ensurePaymentColumns();
    const auth = getRazorpayAuth();
    if (!auth) {
      return res.status(500).json({ success: false, message: "Razorpay is not configured (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)." });
    }

    const localId = req.query.id != null ? parseInt(req.query.id, 10) : null;
    const paymentLinkId = toOptionalString(req.query.payment_link_id);

    let payment;
    if (Number.isFinite(localId)) {
      const [rows] = await pool.query("SELECT * FROM payments WHERE id = ?", [localId]);
      if (!rows.length) return res.status(404).json({ success: false, message: "Payment not found." });
      payment = rows[0];
    } else if (paymentLinkId) {
      const [rows] = await pool.query("SELECT * FROM payments WHERE razorpay_payment_link_id = ?", [paymentLinkId]);
      if (!rows.length) return res.status(404).json({ success: false, message: "Payment not found." });
      payment = rows[0];
    } else {
      return res.status(400).json({ success: false, message: "Provide id or payment_link_id." });
    }

    const linkId = payment.razorpay_payment_link_id;
    if (!linkId) {
      return res.status(400).json({ success: false, message: "Payment does not have a Razorpay payment_link_id stored." });
    }

    const rp = await axios.get(`https://api.razorpay.com/v1/payment_links/${linkId}`, { auth, timeout: 20000 });
    const link = rp.data;
    const rpStatus = link.status || null;

    // Map status best-effort
    const mapped =
      rpStatus === "paid" ? "completed" :
      rpStatus === "expired" ? "failed" :
      rpStatus === "cancelled" ? "failed" :
      "pending";

    await pool.query("UPDATE payments SET razorpay_status = ?, status = ? WHERE id = ?", [rpStatus, mapped, payment.id]);
    const [updated] = await pool.query("SELECT * FROM payments WHERE id = ?", [payment.id]);

    res.json({ success: true, data: { payment: updated[0], razorpay: link } });
  } catch (err) {
    console.error("Get payment status error:", err?.response?.data || err);
    res.status(500).json({ success: false, message: "Failed to get payment status." });
  }
}

/**
 * GET /api/payments?page=&limit=&status=
 */
async function listPayments(req, res) {
  try {
    await ensurePaymentColumns();
    const { page = 1, limit = 10, status } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * limitNum;

    const where = [];
    const params = [];
    if (status && ["pending", "completed", "failed", "refunded"].includes(String(status))) {
      where.push("p.status = ?");
      params.push(String(status));
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM payments p ${whereClause}`, params);
    const total = countRow.total;
    const [rows] = await pool.query(
      `SELECT p.* FROM payments p ${whereClause} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page: Math.floor(offset / limitNum) + 1, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (err) {
    console.error("List payments error:", err);
    res.status(500).json({ success: false, message: "Failed to list payments." });
  }
}

module.exports = { createPaymentLink, getPaymentStatus, listPayments };

