const express = require("express");
const multer = require("multer");
const leadsController = require("../controllers/leadsController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/leads (admin + agent)
router.post("/", authenticate, authorize("admin", "agent"), leadsController.create);

// GET /api/leads?search=&status=&page=&limit= (admin + viewer: all leads; agent: assigned only)
router.get("/", authenticate, leadsController.list);

// GET /api/leads/all?search=&status= (same scope as GET /, no pagination)
router.get("/all", authenticate, leadsController.listAll);

// GET /api/leads/by-creator?user_id|userId|creator_id=&... (admin & viewer — read-only for viewer)
router.get("/by-creator", authenticate, authorize("admin", "viewer"), leadsController.listByCreator);

// POST /api/leads/import (must be before /:id to avoid "import" as id)
router.post("/import", authenticate, authorize("admin"), upload.single("file"), leadsController.importCsv);

// Admin — edit/delete any lead (before /:id so "admin" is not parsed as :id)
router.put("/admin/:id", authenticate, authorize("admin"), leadsController.adminUpdate);
router.delete("/admin/:id", authenticate, authorize("admin"), leadsController.adminRemove);

// GET /api/leads/:id (admin + agent)
router.get("/:id", authenticate, leadsController.getById);

// PUT /api/leads/:id (admin: any lead; agent: only leads assigned to them, agent_id = self)
router.put("/:id", authenticate, authorize("admin", "agent"), leadsController.update);

// DELETE /api/leads/:id (admin: any; agent: only assigned leads)
router.delete("/:id", authenticate, authorize("admin", "agent"), leadsController.remove);

// PUT /api/leads/:id/assign-agent (admin)
router.put("/:id/assign-agent", authenticate, authorize("admin"), leadsController.assignAgentToLead);

module.exports = router;
