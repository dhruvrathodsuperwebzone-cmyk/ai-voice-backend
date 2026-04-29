const express = require("express");
const multer = require("multer");
const voiceController = require("../controllers/voiceController");
const omniAgentsController = require("../controllers/omniAgentsController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/voice/call", authenticate, voiceController.createVoiceCall);
router.post("/voice/call/script", authenticate, voiceController.createVoiceCallWithScript);
router.post("/voice/bulk-call/upload", authenticate, upload.single("file"), voiceController.createBulkCallFromUpload);
router.get("/voice/calls", authenticate, voiceController.getOmniCallLogs);
/** Omnidim agent id in path — all call logs for that agent (same as ?agent_id=) */
router.get("/voice/agents/:agent_id/calls", authenticate, voiceController.getCallLogsForAgent);
router.get("/voice/calls/:call_log_id", authenticate, voiceController.getOmniCallLogById);

/** Admin: each voice agent + which user created it + Omnidim recent call logs per agent */
router.get(
  "/voice/admin/agents-call-logs",
  authenticate,
  authorize("admin"),
  voiceController.listAgentsCallLogsByCreator
);

/** Admin: Omnidim call logs; optional voice_agent_id (DB id), agent_id (Omni id), agent_name, filters */
router.get(
  "/voice/admin/calls",
  authenticate,
  authorize("admin"),
  voiceController.getAdminOmniCallLogs
);

// OmniDimension agents (proxy; uses OMNIDIM_API_KEY)
router.post("/omni/agents", authenticate, omniAgentsController.createAgent);
/** Admin & viewer: all agents from Omnidim account (GET /agents). Register before /omni/agents/:id */
router.get(
  "/omni/admin/omnidim-agents",
  authenticate,
  authorize("admin", "viewer"),
  omniAgentsController.listOmnidimAgentsForAdmin
);
router.get(
  "/omni/admin/agents/:agentId",
  authenticate,
  authorize("admin"),
  omniAgentsController.getOmnidimAgentForAdmin
);
const adminOmnidimAgentUpdateHandlers = [
  authenticate,
  authorize("admin"),
  omniAgentsController.updateOmnidimAgentForAdmin,
];
router.patch("/omni/admin/agents/:agentId", ...adminOmnidimAgentUpdateHandlers);
router.put("/omni/admin/agents/:agentId", ...adminOmnidimAgentUpdateHandlers);
router.delete(
  "/omni/admin/agents/:agentId",
  authenticate,
  authorize("admin"),
  omniAgentsController.deleteOmnidimAgentForAdmin
);
router.get("/omni/agents", authenticate, omniAgentsController.listAgents);
router.get("/omni/agents/:agentId", authenticate, omniAgentsController.getAgent);
router.put("/omni/agents/:agentId", authenticate, omniAgentsController.updateAgent);
router.delete("/omni/agents/:agentId", authenticate, omniAgentsController.deleteAgent);

module.exports = router;
