const express = require("express");
const dashboardController = require("../controllers/dashboardController");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

// GET /api/dashboard/stats (JWT or cookie; counts scoped by role)
router.get("/dashboard/stats", authenticate, dashboardController.getStats);

// GET /api/calls/recent
router.get("/calls/recent", authenticate, dashboardController.getRecentCalls);

// GET /api/revenue
router.get("/revenue", authenticate, dashboardController.getRevenue);

module.exports = router;

