const express = require("express");
const multer = require("multer");
const outboundCallsController = require("../controllers/outboundCallsController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Must be registered before generic /calls/* if any conflict; paths are specific.
// Admin: all Omni voice_agents (new URL; does not change GET /calls/outbound/agents).
router.get(
  "/calls/outbound/agents/all",
  authenticate,
  authorize("admin"),
  outboundCallsController.listAgentsForOutboundAdmin
);

router.get(
  "/calls/outbound/agents",
  authenticate,
  authorize("admin", "agent", "viewer"),
  outboundCallsController.listAgentsForOutbound
);

router.get(
  "/calls/outbound/admin/agents",
  authenticate,
  authorize("admin"),
  outboundCallsController.listAgentsForOutboundAdmin
);

// Quick check that this app + mount are correct (GET should not 404 if you hit the right server/port).
router.get("/calls/outbound/csv", (req, res) => {
  res.json({
    success: true,
    message: "Use POST with multipart/form-data: fields agent_id (text) and file (CSV).",
    post: "/api/calls/outbound/csv",
  });
});

const csvUploadHandlers = [
  authenticate,
  authorize("admin", "agent"),
  upload.single("file"),
  outboundCallsController.createOutboundCallsFromCsv,
];

router.post("/calls/outbound/csv", ...csvUploadHandlers);
router.post("/calls/outbound/csv/", ...csvUploadHandlers);

router.post(
  "/calls/outbound",
  authenticate,
  authorize("admin", "agent"),
  outboundCallsController.createOutboundCall
);

router.get(
  "/calls/outbound/requests",
  authenticate,
  authorize("admin", "agent"),
  outboundCallsController.listMyOutboundRequests
);

module.exports = router;
