const express = require("express");
const multer = require("multer");
const leadsController = require("../controllers/leadsController");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/leads
router.post("/", leadsController.create);

// GET /api/leads?search=&status=&page=&limit=
router.get("/", leadsController.list);

// POST /api/leads/import (must be before /:id to avoid "import" as id)
router.post("/import", upload.single("file"), leadsController.importCsv);

// GET /api/leads/:id
router.get("/:id", leadsController.getById);

// PUT /api/leads/:id
router.put("/:id", leadsController.update);

// DELETE /api/leads/:id
router.delete("/:id", leadsController.remove);

module.exports = router;
