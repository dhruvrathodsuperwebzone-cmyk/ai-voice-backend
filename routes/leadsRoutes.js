const express = require("express");
const multer = require("multer");
const leadsController = require("../controllers/leadsController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/leads (admin)
router.post("/", authenticate, authorize("admin"), leadsController.create);

// GET /api/leads?search=&status=&page=&limit= (admin + agent)
router.get("/", authenticate, leadsController.list);

// POST /api/leads/import (must be before /:id to avoid "import" as id)
router.post("/import", authenticate, authorize("admin"), upload.single("file"), leadsController.importCsv);

// GET /api/leads/:id (admin + agent)
router.get("/:id", authenticate, leadsController.getById);

// PUT /api/leads/:id (admin)
router.put("/:id", authenticate, authorize("admin"), leadsController.update);

// DELETE /api/leads/:id (admin)
router.delete("/:id", authenticate, authorize("admin"), leadsController.remove);

// PUT /api/leads/:id/assign-agent (admin)
router.put("/:id/assign-agent", authenticate, authorize("admin"), leadsController.assignAgentToLead);

module.exports = router;
