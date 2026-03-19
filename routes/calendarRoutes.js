const express = require("express");
const calendarController = require("../controllers/calendarController");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

// Google redirects here (no JWT) — must match GOOGLE_REDIRECT_URI in .env + Google Console
router.get("/calendar/oauth/google-callback", calendarController.oauthGoogleCallback);

// See exact redirect_uri the server uses (paste into Google Console)
router.get("/calendar/oauth/config-debug", authenticate, calendarController.oauthConfigDebug);

// OAuth (call before availability/book/etc.)
router.get("/calendar/oauth/url", authenticate, calendarController.oauthUrl);
router.post("/calendar/oauth/token", authenticate, calendarController.oauthToken);

// Phase 9 — Calendar System
router.get("/calendar/availability", authenticate, calendarController.availability);
router.post("/calendar/book", authenticate, calendarController.book);
router.put("/calendar/reschedule/:eventId", authenticate, calendarController.reschedule);
router.delete("/calendar/cancel/:eventId", authenticate, calendarController.cancel);

module.exports = router;
