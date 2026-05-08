const mysql = require("mysql2/promise");
const winston = require("winston");
require("dotenv").config();

// ─── Logger ────────────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// ─── Config ────────────────────────────────────────────────────────────────────

const validateConfig = () => {
  const required = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
};

// Read once — not re-parsed on every call
const CONNECTION_LIMIT = parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 10;
const IS_PROD = process.env.NODE_ENV === "production";

const createDbConfig = () => {
  let sslConfig = null;
  if (process.env.DB_SSL === "true") {
    sslConfig = {
      rejectUnauthorized: IS_PROD && process.env.DB_SSL_INSECURE !== "true",
    };

    if (process.env.DB_SSL_CA) {
      try {
        sslConfig.ca = require("fs").readFileSync(process.env.DB_SSL_CA);
      } catch {
        logger.warn(
          `Could not read CA file at ${process.env.DB_SSL_CA}, falling back to no-verify.`,
        );
        sslConfig.rejectUnauthorized = false;
      }
    }
  }

  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    connectionLimit: CONNECTION_LIMIT,
    maxIdle: Math.max(Math.floor(CONNECTION_LIMIT * 0.5), 2),
    queueLimit: 0,
    waitForConnections: true,
    idleTimeout: 300_000,
    connectTimeout: 30_000,

    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    typeCast: true,
    nestTables: false,
    rowsAsArray: false,
    multipleStatements: false,
    namedPlaceholders: false,
    ssl: sslConfig,
  };
};

// ─── Pool state ────────────────────────────────────────────────────────────────

let pool = null;
const metrics = {
  createdAt: null,
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  connectionErrors: 0,
  retries: 0,
};

// ─── Init ──────────────────────────────────────────────────────────────────────

const initializeDatabase = async (retries = 3) => {
  if (pool) {
    logger.info("Database pool already initialized");
    return pool;
  }

  validateConfig();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      pool = mysql.createPool(createDbConfig());

      // Smoke-test the pool before declaring it ready
      const conn = await pool.getConnection();
      await conn.execute("SELECT 1");
      conn.release();

      pool.on("connection", (c) =>
        logger.info(`New DB connection: ${c.threadId}`),
      );
      pool.on("error", (err) => {
        metrics.connectionErrors++;
        logger.error("Database pool error:", {
          code: err.code,
          message: err.message,
        });
      });

      metrics.createdAt = new Date();
      logger.info("Database pool initialized");
      return pool;
    } catch (error) {
      pool = null;
      logger.error(`Database init attempt ${attempt}/${retries} failed:`, {
        code: error.code,
        message: error.message,
      });

      if (attempt === retries) throw error;

      const wait = attempt * 2000;
      logger.info(`Retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
};

// ─── testConnection ────────────────────────────────────────────────────────────

const testConnection = async () => {
  if (!pool) await initializeDatabase();

  const start = Date.now();
  const conn = await pool.getConnection();
  try {
    await conn.execute("SELECT 1");
    return {
      success: true,
      duration: Date.now() - start,
      threadId: conn.threadId,
    };
  } finally {
    conn.release();
  }
};

// ─── executeQuery ──────────────────────────────────────────────────────────────

const CONNECTION_ERRORS = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
]);

const executeQuery = async (query, params = []) => {
  if (!pool) await initializeDatabase();

  const start = Date.now();
  metrics.totalQueries++;

  try {
    const [results] = await pool.execute(query, params);
    metrics.successfulQueries++;

    const duration = Date.now() - start;
    if (duration > 2000) {
      logger.warn("Slow query detected", {
        duration,
        query: query.substring(0, 100),
      });
    }

    return results;
  } catch (error) {
    metrics.failedQueries++;

    if (CONNECTION_ERRORS.has(error.code)) {
      metrics.connectionErrors++;
      logger.error("Connection-level query error (pool will recover):", {
        code: error.code,
        query: query.substring(0, 100),
      });
    } else {
      logger.error("Query failed:", {
        code: error.code,
        message: error.message,
        query: query.substring(0, 100),
      });
    }

    throw error;
  }
};

// ─── Misc helpers ──────────────────────────────────────────────────────────────

const getConnection = async () => {
  if (!pool) await initializeDatabase();
  return pool.getConnection();
};

const getPool = () => {
  if (!pool)
    throw new Error(
      "Database pool not initialized. Call initializeDatabase() first.",
    );
  return pool;
};

const getPoolStats = () => {
  if (!pool) return { error: "Database pool not initialized", metrics };
  return {
    ...metrics,
    uptime: metrics.createdAt ? Date.now() - metrics.createdAt.getTime() : 0,
    config: {
      // FIX: does NOT expose host/credentials — callers don't need them
      database: process.env.DB_NAME,
      environment: process.env.NODE_ENV || "development",
      limit: CONNECTION_LIMIT,
    },
  };
};

const healthCheck = async () => {
  try {
    const ping = await testConnection();
    const stats = getPoolStats();
    return {
      status: "healthy",
      database: {
        connected: ping.success,
        responseTime: ping.duration,
        threadId: ping.threadId,
      },
      metrics: {
        totalQueries: stats.totalQueries,
        successfulQueries: stats.successfulQueries,
        failedQueries: stats.failedQueries,
        connectionErrors: stats.connectionErrors,
        retries: stats.retries,
        errorRate:
          stats.totalQueries > 0
            ? Math.round((stats.failedQueries / stats.totalQueries) * 100)
            : 0,
        uptime: stats.uptime,
      },
    };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error.message,
      code: error.code,
      timestamp: new Date().toISOString(),
    };
  }
};

// ─── Shutdown ──────────────────────────────────────────────────────────────────

const closePool = async (timeout = 5000) => {
  if (!pool) {
    logger.info("No database pool to close");
    return;
  }
  try {
    logger.info("Closing database pool...");
    await Promise.race([
      pool.end(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Pool close timeout")), timeout),
      ),
    ]);
    pool = null;
    logger.info("Database pool closed");
  } catch (error) {
    logger.error("Error closing pool:", error);
    try {
      pool = null;
    } catch {}
  }
};

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initializeDatabase,
  testConnection,
  closePool,
  getPool,
  executeQuery,
  getConnection,
  getPoolStats,
  healthCheck,
  logger,
};
