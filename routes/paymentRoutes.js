const express = require("express");
const paymentsController = require("../controllers/paymentsController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// POST /api/payment/link
router.post("/payment/link", authenticate, paymentsController.createPaymentLink);

// GET /api/payment/status?id= OR ?payment_link_id=
router.get("/payment/status", authenticate, paymentsController.getPaymentStatus);

// GET /api/payments/admin — admin & viewer: all payments (read-only for viewer), optional ?user_id= / ?userId=
router.get("/payments/admin", authenticate, authorize("admin", "viewer"), paymentsController.listPaymentsAdmin);

// GET /api/payments (own rows only)
router.get("/payments", authenticate, paymentsController.listPayments);

module.exports = router;

