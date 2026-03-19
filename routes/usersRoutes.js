const express = require("express");
const usersController = require("../controllers/usersController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// Admin only
router.get("/users", authenticate, authorize("admin"), usersController.list);
router.post("/users", authenticate, authorize("admin"), usersController.create);

module.exports = router;
