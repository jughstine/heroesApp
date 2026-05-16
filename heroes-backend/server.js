const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const {
  initializeDatabase,
  testConnection,
  closePool,
} = require("./config/database");
const {
  scheduleStatusUpdates,
  createManualTriggerRoute,
  autoStatusChangeService,
} = require("./services/autoStatusChange");

const heroesRoutes = require("./routes/heroes");
const uploadRoutes = require("./routes/upload");
const announcementsRoutes = require("./routes/announcements");

const {
  router: usersRoutes,
  shutdown: shutdownUsers,
} = require("./routes/users");
process.on("SIGTERM", () => {
  shutdownUsers();
});

const formsRoutes = require("./routes/forms");
const adminForms = require("./routes/admin_forms");
const { router: adminAuthRoutes } = require("./routes/admin");
const inquiriesRouter = require("./routes/inquiries");
const psaRoutes = require("./routes/psa");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// ─── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  "https://afppgmc.com",
  "https://www.afppgmc.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://192.168.254.101:5173",
  "http://192.168.254.101:3000",
  "http://127.0.0.1:5173",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);

    if (!IS_PROD) {
      console.warn("CORS [DEV]: Unexpected origin allowed:", origin);
      return callback(null, true);
    }

    console.error("CORS [PROD]: BLOCKED origin:", origin);
    callback(new Error("Not allowed by CORS policy"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
  ],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
  optionsSuccessStatus: 200,
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ─── Body parsing ──────────────────────────────────────────────────────────────
const LARGE_LIMIT = process.env.MAX_FILE_SIZE || "50mb";

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(
  "/api/upload",
  express.json({ limit: LARGE_LIMIT }),
  express.urlencoded({ extended: true, limit: LARGE_LIMIT }),
);

// ─── Routes ────────────────────────────────────────────────────────────────────

app.use("/api/heroes", heroesRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/announcements", announcementsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/forms", formsRoutes);
app.use("/api/inquiries", inquiriesRouter);
app.use("/api/admin", adminAuthRoutes);
app.use("/api/admin_forms", adminForms);
app.use("/api", psaRoutes);

createManualTriggerRoute(app);

// ─── Health check ──────────────────────────────────────────────────────────────

app.get("/api/health", async (req, res) => {
  let dbStatus = "unknown";
  let dbError = null;

  try {
    await testConnection();
    dbStatus = "connected";
  } catch (err) {
    dbStatus = "disconnected";
    dbError = err.message;
  }

  let cycleInfo = null;
  try {
    const info = autoStatusChangeService.getCurrentCycleInfo();
    const dayOfYear = autoStatusChangeService.getDayOfYear();
    cycleInfo = info
      ? {
          currentCycle: info.cycle,
          cycleName: info.name,
          currentPeriod: info.period,
          dayOfYear,
          daysLeftInPeriod: info.daysLeftInPeriod,
          nextPeriod: info.nextPeriod,
        }
      : { error: "Could not determine current cycle", dayOfYear };
  } catch (err) {
    cycleInfo = { error: "Could not fetch cycle info", details: err.message };
  }

  res.json({
    success: true,
    message: "Server is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    version: process.env.APP_VERSION || "1.0.0",
    server: {
      port: PORT,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      platform: process.platform,
      nodeVersion: process.version,
    },
    services: {
      database: dbStatus,
      autoStatusChange: "active (Calendar Cycle-based)",
      cycleInfo,
      ...(dbError && { databaseError: dbError }),
    },
    headers: {
      origin: req.headers.origin || "none",
      userAgent: req.headers["user-agent"] || "none",
    },
  });
});

// ─── Diagnostic endpoints (internal / dev only) ────────────────────────────────

function internalOnly(req, res, next) {
  if (IS_PROD) {
    return res
      .status(404)
      .json({ success: false, error: "Endpoint not found" });
  }
  next();
}

app.get("/api/check-routes", internalOnly, (req, res) => {
  res.json({
    success: true,
    routes: [
      "/api/heroes",
      "/api/upload",
      "/api/announcements",
      "/api/users",
      "/api/forms",
      "/api/inquiries",
      "/api/admin",
      "/api/admin_forms",
      "/api/health",
      "/admin/trigger-status-update",
      "/admin/users-at-risk",
      "/admin/cycle-statistics",
      "/admin/current-cycle",
      "/api/",
    ],
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/diagnostic/database", internalOnly, async (req, res) => {
  const startTime = Date.now();
  try {
    const envCheck = {
      DB_HOST: process.env.DB_HOST ? "SET" : "MISSING",
      DB_PORT: process.env.DB_PORT || "3306 (default)",
      DB_USER: process.env.DB_USER ? "SET" : "MISSING",
      DB_PASSWORD: process.env.DB_PASSWORD ? "SET" : "MISSING",
      DB_NAME: process.env.DB_NAME ? "SET" : "MISSING",
    };

    let poolTest = { status: "failed", error: null };
    try {
      const result = await testConnection();
      poolTest = { status: "success", ...result };
    } catch (err) {
      poolTest = {
        status: "failed",
        error: { code: err.code, message: err.message },
      };
    }

    let dnsTest = { status: "unknown" };
    if (process.env.DB_HOST) {
      try {
        const dns = require("dns").promises;
        const dnsStart = Date.now();
        const resolved = await dns.lookup(process.env.DB_HOST);
        dnsTest = {
          status: "success",
          duration: Date.now() - dnsStart,
          resolved,
        };
      } catch (err) {
        dnsTest = {
          status: "failed",
          error: { code: err.code, message: err.message },
        };
      }
    }

    res.json({
      success: true,
      totalDuration: `${Date.now() - startTime}ms`,
      diagnostic: {
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
        environmentVariables: envCheck,
        tests: { poolConnection: poolTest, dnsResolution: dnsTest },
        summary: {
          canConnectViaPool: poolTest.status === "success",
          canResolveDNS: dnsTest.status === "success",
          overallStatus:
            poolTest.status === "success" ? "healthy" : "unhealthy",
        },
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Diagnostic test failed",
      details: { message: err.message, code: err.code },
      duration: `${Date.now() - startTime}ms`,
    });
  }
});

app.get("/api/diagnostic/network", internalOnly, (req, res) => {
  const os = require("os");
  const ifaces = os.networkInterfaces();
  res.json({
    success: true,
    serverInfo: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      networkInterfaces: Object.fromEntries(
        Object.entries(ifaces).map(([name, addrs]) => [
          name,
          addrs.filter((a) => a.family === "IPv4"),
        ]),
      ),
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/debugme", internalOnly, (req, res) => {
  res.json({
    maxFileSize: process.env.MAX_FILE_SIZE,
    nodeEnv: process.env.NODE_ENV,
    dbHost: process.env.DB_HOST ? "SET" : "NOT SET",
    spacesKey: process.env.SPACES_KEY ? "SET" : "NOT SET",
    spacesSecret: process.env.SPACES_SECRET ? "SET" : "NOT SET",
    spacesBucket: process.env.SPACES_BUCKET || "NOT SET",
    spacesEndpoint: process.env.SPACES_ENDPOINT || "NOT SET",
  });
});

// ─── Test upload ───────────────────────────────────────────────────────────────

const testUpload = multer({
  limits: { fileSize: 500 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

app.post(
  "/api/test-upload-direct",
  internalOnly,
  testUpload.single("file"),
  (req, res) => {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });

    res.json({
      success: true,
      message: "Direct upload test successful",
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        sizeMB: (req.file.size / (1024 * 1024)).toFixed(2),
        mimetype: req.file.mimetype,
      },
    });
  },
);

// ─── Error handlers ────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error("Server error:", err);
  res.status(500).json({
    success: false,
    error: IS_PROD ? "Something went wrong!" : err.message,
    timestamp: new Date().toISOString(),
  });
});

app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async () => {
  try {
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Bootstrap ─────────────────────────────────────────────────────────────────

const startServer = async () => {
  try {
    await initializeDatabase();
    await testConnection();

    if (process.env.ENABLE_PSA_WORKER === "true") {
      require("./workers/psaWorker");
    }

    scheduleStatusUpdates();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Server running on port ${PORT} [${process.env.NODE_ENV || "development"}]`,
      );
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
};

startServer();
