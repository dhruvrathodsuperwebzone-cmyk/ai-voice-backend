const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const campaignsController = require("../controllers/campaignsController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "storage", "uploads", "campaigns");
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const userId = req.user?.id ?? "unknown";
    const original = String(file?.originalname || "upload");
    const ext = path.extname(original) || ".csv";
    const safeBase = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `campaign_leads_${userId}_${Date.now()}_${safeBase}${ext}`);
  },
});

const upload = multer({ storage });

function maybeUploadFile(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  return upload.single("file")(req, res, next);
}

// POST /api/campaign
// Supports JSON body OR multipart with CSV file field name: `file`
router.post("/campaign", authenticate, authorize("admin"), maybeUploadFile, campaignsController.create);

// GET /api/campaigns
router.get("/campaigns", authenticate, authorize("admin", "agent"), campaignsController.list);

// GET /api/campaign/:id
router.get("/campaign/:id", authenticate, authorize("admin", "agent"), campaignsController.getById);

// PUT /api/campaign/:id
router.put("/campaign/:id", authenticate, authorize("admin"), maybeUploadFile, campaignsController.update);

// DELETE /api/campaign/:id
router.delete("/campaign/:id", authenticate, authorize("admin"), campaignsController.remove);

module.exports = router;

