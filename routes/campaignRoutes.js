const express = require("express");
const campaignsController = require("../controllers/campaignsController");

const router = express.Router();

// POST /api/campaign
router.post("/campaign", campaignsController.create);

// GET /api/campaigns
router.get("/campaigns", campaignsController.list);

// GET /api/campaign/:id
router.get("/campaign/:id", campaignsController.getById);

// PUT /api/campaign/:id
router.put("/campaign/:id", campaignsController.update);

// DELETE /api/campaign/:id
router.delete("/campaign/:id", campaignsController.remove);

module.exports = router;

