const express = require("express");
const paymentsController = require("../controllers/paymentsController");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

// POST /api/payment/link
router.post("/payment/link", authenticate, paymentsController.createPaymentLink);

// GET /api/payment/status?id= OR ?payment_link_id=
router.get("/payment/status", authenticate, paymentsController.getPaymentStatus);

// GET /api/payments
router.get("/payments", authenticate, paymentsController.listPayments);

module.exports = router;

