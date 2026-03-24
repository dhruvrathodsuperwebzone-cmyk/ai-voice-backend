const express = require("express");
const scriptsController = require("../controllers/scriptsController");

const router = express.Router();

// POST /api/scripts
router.post("/scripts", scriptsController.create);

// GET /api/scripts (list; must be before /:id)
router.get("/scripts", scriptsController.list);

// GET /api/scripts/names (dropdown-friendly)
router.get("/scripts/names", scriptsController.listNames);

// GET /api/scripts/:id
router.get("/scripts/:id", scriptsController.getById);

// PUT /api/scripts/:id
router.put("/scripts/:id", scriptsController.update);

// DELETE /api/scripts/:id
router.delete("/scripts/:id", scriptsController.remove);

module.exports = router;
