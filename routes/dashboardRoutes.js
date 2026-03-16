const express = require("express");
const dashboardController = require("../controllers/dashboardController");

const router = express.Router();

// GET /api/dashboard/stats
router.get("/dashboard/stats", dashboardController.getStats);

// GET /api/calls/recent
router.get("/calls/recent", dashboardController.getRecentCalls);

// GET /api/revenue
router.get("/revenue", dashboardController.getRevenue);

module.exports = router;

