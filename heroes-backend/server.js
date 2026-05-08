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
} = require("./services/autoStatusChange");

const heroesRoutes = require("./routes/heroes");
const uploadRoutes = require("./routes/upload");
const announcementsRoutes = require("./routes/announcements");
const usersRoutes = require("./routes/users");
const formsRoutes = require("./routes/forms");
const adminForms = require("./routes/admin_forms");
const { router: adminAuthRoutes } = require("./routes/admin");
const inquiriesRouter = require("./routes/inquiries");
const psaRoutes = require("./routes/psa");

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      // Production
      "https://afppgmc.com",
      "https://www.afppgmc.com",

      // Development
      "http://localhost:3000",
      "http://localhost:5173",
      "http://192.168.254.101:5173",
      "http://192.168.254.101:3000",
      "http://127.0.0.1:5173",
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ];
    // Development
    if (process.env.NODE_ENV === "development") {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // In development
        console.warn("CORS [DEV]: Unexpected origin allowed:", origin);
        callback(null, true);
      }
    }
    // Production: Strict
    else {
      if (!origin) {
        return callback(null, true);
      }
      // production
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.error("CORS [PROD]: BLOCKED origin:", origin);
        callback(new Error("Not allowed by CORS policy"), false);
      }
    }
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
app.use((req, res, next) => {
  next();
});

app.use(
  express.json({
    limit: process.env.MAX_FILE_SIZE || "500mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(
  express.urlencoded({
    extended: true,
    limit: process.env.MAX_FILE_SIZE || "500mb",
  }),
);

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

// ─── check routes ───────────────────────────────────────────────────────────────────
app.get("/api/check-routes", (req, res) => {
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
      "/api/test-inquiries",
      "/admin/trigger-status-update",
      "/admin/users-at-risk",
      "/admin/cycle-statistics",
      "/admin/current-cycle",
      "/api/",
    ],
    timestamp: new Date().toISOString(),
  });
});

// ─── health check ───────────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    let dbStatus = "unknown";
    let dbError = null;

    try {
      await testConnection();
      dbStatus = "connected";
    } catch (error) {
      dbStatus = "disconnected";
      dbError = error.message;
    }

    // Get current cycle info
    let cycleInfo = null;
    try {
      const {
        autoStatusChangeService,
      } = require("./services/autoStatusChange");
      const currentCycleInfo = autoStatusChangeService.getCurrentCycleInfo();
      const dayOfYear = autoStatusChangeService.getDayOfYear();

      if (currentCycleInfo) {
        cycleInfo = {
          currentCycle: currentCycleInfo.cycle,
          cycleName: currentCycleInfo.name,
          currentPeriod: currentCycleInfo.period,
          dayOfYear: dayOfYear,
          daysLeftInPeriod: currentCycleInfo.daysLeftInPeriod,
          nextPeriod: currentCycleInfo.nextPeriod,
        };
      } else {
        cycleInfo = {
          error: "Could not determine current cycle",
          dayOfYear: dayOfYear,
        };
      }
    } catch (error) {
      cycleInfo = {
        error: "Could not fetch cycle info",
        details: error.message,
      };
    }

    const healthData = {
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
        cycleInfo: cycleInfo,
        ...(dbError && { databaseError: dbError }),
      },
      headers: {
        origin: req.headers.origin || "none",
        userAgent: req.headers["user-agent"] || "none",
      },
    };

    res.json(healthData);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

const shutdown = async () => {
  try {
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── start server ───────────────────────────────────────────────────────────────────

const DISABLE_PSA_WORKER = true;
const startServer = async () => {
  try {
    await initializeDatabase();
    await testConnection();

    if (!DISABLE_PSA_WORKER) {
      require("./workers/psaWorker");
    }

    scheduleStatusUpdates();
    app.listen(PORT, "0.0.0.0", () => {});
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
};

// ─── test server ───────────────────────────────────────────────────────────────────

app.get("/api/diagnostic/database", async (req, res) => {
  const startTime = Date.now();

  try {
    const diagnostic = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || "development",

      // Environment variables check
      environmentVariables: {
        DB_HOST: process.env.DB_HOST ? "SET" : "MISSING",
        DB_PORT: process.env.DB_PORT || "3306 (default)",
        DB_USER: process.env.DB_USER ? "SET" : "MISSING",
        DB_PASSWORD: process.env.DB_PASSWORD ? "SET" : "MISSING",
        DB_NAME: process.env.DB_NAME ? "SET" : "MISSING",
      },

      // Database configuration
      databaseConfig: {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        database: process.env.DB_NAME,
        ssl: false,
      },
    };

    //  MySQL connection
    let connectionTest = {
      status: "failed",
      error: null,
      duration: 0,
    };

    try {
      const mysql = require("mysql2/promise");
      const testConfig = {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: false,
        connectTimeout: 5000,
      };

      const testStart = Date.now();
      const connection = await mysql.createConnection(testConfig);

      try {
        const [rows] = await connection.execute(
          "SELECT 1 as test, NOW() as timestamp, CONNECTION_ID() as conn_id, VERSION() as version",
        );
        connectionTest = {
          status: "success",
          duration: Date.now() - testStart,
          result: rows[0],
          connectionId: rows[0].conn_id,
          serverVersion: rows[0].version,
        };
      } finally {
        await connection.end();
      }
    } catch (error) {
      connectionTest = {
        status: "failed",
        duration: Date.now() - startTime,
        error: {
          code: error.code,
          errno: error.errno,
          sqlState: error.sqlState,
          message: error.message,
        },
      };
    }

    // Pool connection test
    let poolTest = {
      status: "failed",
      error: null,
    };

    try {
      const { testConnection } = require("./config/database");
      const poolResult = await testConnection();
      poolTest = {
        status: "success",
        ...poolResult,
      };
    } catch (error) {
      poolTest = {
        status: "failed",
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }

    // DNS resolution check
    let dnsTest = {
      status: "unknown",
      error: null,
    };

    if (process.env.DB_HOST) {
      try {
        const dns = require("dns").promises;
        const dnsStart = Date.now();
        const addresses = await dns.lookup(process.env.DB_HOST);
        dnsTest = {
          status: "success",
          duration: Date.now() - dnsStart,
          resolved: addresses,
        };
      } catch (error) {
        dnsTest = {
          status: "failed",
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
    }

    const totalDuration = Date.now() - startTime;

    res.json({
      success: true,
      message: "Database diagnostic completed",
      totalDuration: `${totalDuration}ms`,
      diagnostic: {
        ...diagnostic,
        tests: {
          directConnection: connectionTest,
          poolConnection: poolTest,
          dnsResolution: dnsTest,
        },
        summary: {
          canConnectDirectly: connectionTest.status === "success",
          canConnectViaPool: poolTest.status === "success",
          canResolveDNS: dnsTest.status === "success",
          overallStatus:
            connectionTest.status === "success" ? "healthy" : "unhealthy",
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Diagnostic test failed",
      details: {
        message: error.message,
        code: error.code,
        stack: error.stack,
      },
      duration: `${Date.now() - startTime}ms`,
    });
  }
});

// Network connectivity test endpoint
app.get("/api/diagnostic/network", async (req, res) => {
  try {
    const os = require("os");
    const networkInterfaces = os.networkInterfaces();

    res.json({
      success: true,
      serverInfo: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        networkInterfaces: Object.keys(networkInterfaces).reduce(
          (acc, name) => {
            acc[name] = networkInterfaces[name].filter(
              (iface) => iface.family === "IPv4",
            );
            return acc;
          },
          {},
        ),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// test env
app.get("/api/debugme", (req, res) => {
  res.json({
    maxFileSize: process.env.MAX_FILE_SIZE,
    nodeEnv: process.env.NODE_ENV,
    dbHost: process.env.DB_HOST ? "SET" : "NOT SET",

    spacesKey: process.env.SPACES_KEY ? "SET" : "NOT SET",
    spacesSecret: process.env.SPACES_SECRET ? "SET" : "NOT SET",
    spacesBucket: process.env.SPACES_BUCKET || "NOT SET",
    spacesEndpoint: process.env.SPACES_ENDPOINT || "NOT SET",

    allEnvKeys: Object.keys(process.env).filter(
      (key) => key.includes("MAX_FILE") || key.includes("NODE_ENV"),
    ),
  });
});

// upload size
const testUpload = multer({
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  },
  storage: multer.memoryStorage(),
});

// Test upload endpoint
app.post("/api/test-upload-direct", testUpload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded",
      });
    }

    const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);

    res.json({
      success: true,
      message: "Direct upload test successful",
      fileInfo: {
        originalName: req.file.originalname,
        size: req.file.size,
        sizeMB: fileSizeMB,
        mimetype: req.file.mimetype,
        server: "Node.js direct",
        nginxBypassed: true,
      },
    });
  } catch (error) {
    console.error("Test upload error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      errorCode: error.code,
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({
    success: false,
    error:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong!",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
});

startServer();
