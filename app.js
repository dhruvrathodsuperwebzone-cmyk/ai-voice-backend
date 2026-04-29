require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/authRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const leadsRoutes = require("./routes/leadsRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const scriptRoutes = require("./routes/scriptRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const calendarRoutes = require("./routes/calendarRoutes");
const usersRoutes = require("./routes/usersRoutes");
const voiceRoutes = require("./routes/voiceRoutes");
const outboundCallRoutes = require("./routes/outboundCallRoutes");
const { startCampaignDialer } = require("./services/campaignDialer");

const app = express();

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : ["http://localhost:5173", "http://127.0.0.1:5173"];

app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("CHALE CHHE");
});

// Auth APIs (under /api)
app.use("/api", authRoutes);
app.use("/api", usersRoutes);
// Dashboard APIs (under /api)
app.use("/api", dashboardRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api", campaignRoutes);
app.use("/api", scriptRoutes);
app.use("/api", paymentRoutes);
app.use("/api", calendarRoutes);
app.use("/api", outboundCallRoutes);
app.use("/api", voiceRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startCampaignDialer();
});