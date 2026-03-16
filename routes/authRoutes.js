const express = require("express");
const authController = require("../controllers/authController");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

// Public
router.post("/register", authController.register);
router.post("/login", authController.login);

// Protected (require valid JWT)
router.get("/profile", authenticate, authController.me);
router.post("/logout", authenticate, authController.logout);

module.exports = router;
