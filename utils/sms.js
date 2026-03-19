const axios = require("axios");

/**
 * Very small SMS abstraction.
 *
 * Supported modes:
 * - SMS_WEBHOOK_URL: POST { to, message } to your own SMS service.
 *
 * If no SMS config is set, sending is skipped.
 */
async function sendSms(to, message) {
  const toStr = to != null ? String(to).trim() : "";
  const msgStr = message != null ? String(message).trim() : "";
  if (!toStr || !msgStr) return { sent: false, reason: "missing_to_or_message" };

  const webhook = process.env.SMS_WEBHOOK_URL ? String(process.env.SMS_WEBHOOK_URL).trim() : "";
  if (!webhook) return { sent: false, reason: "sms_not_configured" };

  await axios.post(webhook, { to: toStr, message: msgStr }, { timeout: 15000 });
  return { sent: true };
}

module.exports = { sendSms };

