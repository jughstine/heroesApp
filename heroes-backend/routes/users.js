const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const router = express.Router();
const {
  getPool,
  getConnection,
  executeQuery,
  healthCheck,
  testConnection,
  logger,
} = require("../config/database");
const nodemailer = require("nodemailer");
require("dotenv").config();
const multer = require("multer");
const ExcelJS = require("exceljs");
const Papa = require("papaparse");
const { authenticateAdminToken } = require("./admin");
const jwt = require("jsonwebtoken");
const { LRUCache } = require("lru-cache");

// ============================================================
// CONSTANTS
// ============================================================

const TOKEN_EXPIRY_HOURS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

const OFFICER_RANKS = new Set([
  "2LT",
  "1LT",
  "CPT",
  "MAJ",
  "LTC",
  "LTCOL",
  "GEN",
  "COMMO",
  "COL",
  "CDR",
  "BGEN",
  "MGEN",
  "LGEN",
  "ADM",
  "VADM",
  "RADM",
  "CAPT",
  "LCDR",
  "LTSG",
  "LTJG",
  "ENS",
  "O-W",
]);

const TABLE_ALLOWLIST = new Map([
  ["heroes_tbl", "heroes_tbl"],
  ["resumption_table", "resumption_table"],
  ["beneficiaries_table", "beneficiaries_table"],
]);

/** Returns the safe table name or throws. Never interpolate a raw user value. */
function safeTable(name) {
  if (!TABLE_ALLOWLIST.has(name)) {
    throw Object.assign(new Error(`Invalid table: ${name}`), {
      code: "INVALID_TABLE",
      statusCode: 400,
    });
  }
  return TABLE_ALLOWLIST.get(name);
}

// ----------- UTILITIES

function formatAfpsn(afpsn, penrank) {
  if (!afpsn) return afpsn;
  if (penrank && OFFICER_RANKS.has(penrank.trim().toUpperCase())) {
    return afpsn.startsWith("O-") ? afpsn : `O-${afpsn}`;
  }
  return afpsn;
}

function normalizeAfpsnSql(col) {
  return `REGEXP_REPLACE(UPPER(TRIM(${col})), '[^0-9]', '')`;
}

function normalizeAfpsnForMatching(afpsn) {
  if (!afpsn) return "";
  return afpsn.toString().replace(/\D/g, "");
}

function calculateAge(birthDate) {
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
  return age;
}

const formatDateForDB = (dateStr) => {
  if (!dateStr || dateStr.trim() === "") return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return null;
  }
};

const filterPassword = (password) => {
  if (typeof password !== "string") return "";
  return password.replace(/[<>;"'`\\]/g, "").trim();
};

const validatePasswordStrength = (password) => {
  const errors = [];
  if (password.length < 8)
    errors.push("Password must be at least 8 characters");
  if (password.length > 128)
    errors.push("Password must be less than 128 characters");
  if (!/\d/.test(password))
    errors.push("Password must contain at least one number");
  if (!/[a-zA-Z]/.test(password))
    errors.push("Password must contain at least one letter");
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password))
    errors.push("Password must contain at least one special character");
  if (/(.)\1{2,}/.test(password))
    errors.push("Password cannot contain more than 2 repeated characters");
  if (/^(123456|password|qwerty|abc123|admin|letmein)/i.test(password))
    errors.push("Password cannot be a common password");
  return { isValid: errors.length === 0, errors };
};

// EMAIL

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 2525,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 30000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  debug: process.env.NODE_ENV === "development",
  logger: process.env.NODE_ENV === "development",
});

transporter.verify((error) => {
  if (error) logger.error("SMTP verify failed:", error.message);
});

function buildEmailHtml(type, vars = {}) {
  const year = new Date().getFullYear();
  const header = (
    title,
    color = "linear-gradient(135deg,#1e3a2a 0%,#2f5233 100%)",
  ) => `
    <div style="background:${color};color:#fff;padding:25px 20px;text-align:center;border-bottom:5px solid #c9b458;">
      <img src="https://psahelpline.ph/img/ecert/afp/PGMC.png" alt="AFP Logo" style="width:90px;height:auto;margin-bottom:10px;"/>
      <h1 style="margin:0;font-size:22px;text-transform:uppercase;letter-spacing:1px;">${title}</h1>
    </div>`;
  const footer = `
    <div style="text-align:center;color:#6b7280;font-size:12px;padding:15px;background:#f3f4f6;border-top:1px solid #e5e7eb;">
      <p>This is an automated message. Please do not reply to this email.</p>
      <p>&copy; ${year} AFP Pension and Gratuity Management Center. All rights reserved.</p>
    </div>`;
  const wrap = (content) => `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{font-family:'Segoe UI',Arial,sans-serif;line-height:1.6;color:#222;background:#e5e7eb;margin:0;padding:0;}
    .container{max-width:600px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,.1);}
    .content{padding:30px;background:#f9fafb;}
    .code-box{background:#fff;border:2px dashed #2f5233;padding:20px;text-align:center;margin:20px 0;border-radius:8px;}
    .code{font-size:36px;font-weight:bold;color:#1e3a2a;letter-spacing:8px;font-family:'Courier New',monospace;}
    .warning{background:#fff3cd;border-left:5px solid #b38f00;padding:12px 16px;margin:25px 0;border-radius:6px;font-size:14px;}
    .info{background:#e8f4fd;border-left:4px solid #007AFF;padding:12px;margin:20px 0;}
    strong{color:#111827;}</style>
    </head><body><div class="container">${content}${footer}</div></body></html>`;

  if (type === "reset") {
    return wrap(`${header("Password Change Request")}
      <div class="content">
        <p>Dear Pensioner,</p>
        <p>You have submitted a password change request. Use the code below to reset your password:</p>
        <div class="code-box"><div class="code">${vars.code}</div>
          <p style="margin:10px 0 0;color:#666;font-size:14px;">This code will expire in <strong>10 minutes</strong>.</p>
        </div>
        <p>If you did not request this, you can safely ignore this email. <strong>Do not give this code to anyone.</strong></p>
        <p>Respectfully,<br><strong>AFP Pension and Gratuity Management Center</strong></p>
      </div>`);
  }

  if (type === "reset_confirm") {
    return wrap(`${header("Password Changed Successfully")}
      <div class="content">
        <p>Dear Pensioner,</p>
        <p>Your password has been successfully changed.</p>
        <div class="warning"><strong>⚠️ Security Notice:</strong><br>If you did not make this change, please contact support immediately.</div>
        <p><strong>Time:</strong> ${new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "full", timeStyle: "long" })}</p>
        <p>Respectfully,<br><strong>AFP Pension and Gratuity Management Center</strong></p>
      </div>`);
  }

  if (type === "delete") {
    return wrap(`${header("Account Deleted")}
      <div class="content">
        <p>Hello,</p>
        <p>Your AFPPGMC account has been permanently deleted as requested.</p>
        <div class="warning"><strong>⚠️ Notice:</strong><br>If you did not request this, please contact support immediately.</div>
        <p><strong>Time:</strong> ${new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "full", timeStyle: "long" })}</p>
        <p>Best regards,<br>AFP Pension and Gratuity Management Center</p>
      </div>`);
  }

  if (type === "deactivate") {
    return wrap(`${header("Account Deactivated")}
      <div class="content">
        <p>Hello,</p>
        <p>Your AFPPGMC Heroes account has been temporarily deactivated.</p>
        <div class="info"><strong>Reactivation:</strong><br>You can reactivate your account at any time by logging in again.</div>
        <div class="warning"><strong>⚠️ Notice:</strong><br>If you did not request this, please contact support immediately.</div>
        <p><strong>Time:</strong> ${new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", dateStyle: "full", timeStyle: "long" })}</p>
        <p>Best regards,<br>AFP Pension and Gratuity Management Center Team</p>
      </div>`);
  }

  return "";
}

// BLACKLIST CACHE

/** 5 000-entry LRU; TTL matches the 7-day token lifetime stored in token_blacklist. */
const blacklistCache = new LRUCache({
  max: 5000,
  ttl: 7 * 24 * 60 * 60 * 1000,
  ttlAutopurge: true,
});

// AUTH MIDDLEWARE

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access denied. Please log in.",
      code: "NO_TOKEN",
    });
  }

  try {
    if (blacklistCache.has(token)) {
      return res.status(401).json({
        success: false,
        error: "Session expired. Please log in again.",
        code: "TOKEN_BLACKLISTED",
      });
    }

    const blacklisted = await executeQuery(
      "SELECT id FROM token_blacklist WHERE token = ?",
      [token],
    );
    if (blacklisted.length > 0) {
      blacklistCache.set(token, true);
      return res.status(401).json({
        success: false,
        error: "Session expired. Please log in again.",
        code: "TOKEN_BLACKLISTED",
      });
    }

    // Try admin token first (has issuer/audience), fall back to user token
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: "afppgmc-admin-web",
        audience: "afppgmc-admin-panel",
      });
    } catch {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    }

    next();
  } catch {
    return res.status(403).json({
      success: false,
      error: "Invalid or expired session.",
      code: "INVALID_TOKEN",
    });
  }

  const decoded = jwt.decode(token);
};

// MIDDLEWARE

const sanitizeInput = (req, res, next) => {
  for (const key in req.body) {
    if (
      key !== "password" &&
      key !== "currentPassword" &&
      key !== "newPassword" &&
      key !== "reason" && // ← add this
      typeof req.body[key] === "string"
    ) {
      req.body[key] = validator.escape(req.body[key].trim());
    }
  }
  next();
};

const validateDatabaseConnection = async (req, res, next) => {
  try {
    await testConnection();
    next();
  } catch (error) {
    logger.error("DB connection validation failed:", {
      code: error.code,
      message: error.message,
      endpoint: req.path,
    });
    return res.status(503).json({
      success: false,
      error:
        "Database service temporarily unavailable. Please try again later.",
      code: "DB_CONNECTION_FAILED",
      timestamp: new Date().toISOString(),
    });
  }
};

// RATE LIMITERS

const mkLimiter = (windowMs, max, msg) =>
  rateLimit({
    windowMs,
    max,
    message: { success: false, error: msg, code: "RATE_LIMITED" },
    standardHeaders: true,
    legacyHeaders: false,
  });

const identityLimiter = mkLimiter(
  15 * 60 * 1000,
  25,
  "Too many identity validation attempts. Please try again later.",
);
const createAccountLimiter = mkLimiter(
  30 * 60 * 1000,
  20,
  "Too many account creation attempts. Please try again later.",
);
const loginLimiter = mkLimiter(
  15 * 60 * 1000,
  20,
  "Too many login attempts. Please try again after 15 minutes.",
);
const pushTokenLimiter = mkLimiter(
  15 * 60 * 1000,
  1000,
  "Too many push token update attempts. Please try again later.",
);
const profileUpdateLimiter = mkLimiter(
  15 * 60 * 1000,
  5,
  "Too many update attempts. Please try again later.",
);
const verifyPasswordLimiter = mkLimiter(
  15 * 60 * 1000,
  10,
  "Too many verification attempts. Please try again later.",
);
// FILE UPLOAD

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    if (
      ok.includes(file.mimetype) ||
      /\.(csv|xlsx|xls)$/i.test(file.originalname)
    )
      cb(null, true);
    else
      cb(new Error("Invalid file type. Only CSV and Excel files are allowed."));
  },
});

const parseCSV = (buffer) =>
  Papa.parse(buffer.toString("utf-8"), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.toLowerCase().trim(),
  }).data;

const parseExcel = async (buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  const headers = [];
  const data = [];
  const resolve = (v) => {
    if (v == null) return "";
    if (typeof v === "object" && "result" in v) return resolve(v.result);
    if (typeof v === "object" && "richText" in v)
      return v.richText.map((r) => r.text).join("");
    if (v instanceof Date) return v.toLocaleDateString();
    return String(v);
  };
  sheet.eachRow((row, rowNum) => {
    const vals = row.values.slice(1).map(resolve);
    if (rowNum === 1) headers.push(...vals.map((h) => h.toLowerCase().trim()));
    else {
      const obj = {};
      headers.forEach((k, i) => {
        obj[k] = vals[i] ?? "";
      });
      data.push(obj);
    }
  });
  return data;
};

// TOKEN MANAGEMENT

const generateValidationToken = (data) => ({
  token: crypto.randomBytes(32).toString("hex"),
  data,
});

const storeValidationToken = async (
  token,
  data,
  expiresInHours = TOKEN_EXPIRY_HOURS,
) => {
  const expiresAt = new Date(Date.now() + expiresInHours * 3600000);
  const jsonData = typeof data === "string" ? data : JSON.stringify(data);
  await executeQuery(
    `INSERT INTO signup_tokens (token, data, expires_at, created_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE data=VALUES(data), expires_at=VALUES(expires_at), created_at=NOW()`,
    [token, jsonData, expiresAt],
  );
  return token;
};

const getValidationToken = async (token) => {
  const results = await executeQuery(
    "SELECT data, expires_at FROM signup_tokens WHERE token=? AND expires_at>NOW()",
    [token],
  );
  if (results.length === 0)
    throw new Error("Invalid or expired validation token");
  const raw = results[0].data;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};

const retryWithBackoff = async (operation, maxRetries = MAX_RETRY_ATTEMPTS) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error.code === "ER_LOCK_DEADLOCK" ||
        error.code === "ER_LOCK_WAIT_TIMEOUT" ||
        error.errno === 1213 ||
        error.errno === 1205;
      if (!retryable || attempt === maxRetries) throw error;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `Retry ${attempt}/${maxRetries} in ${delay}ms (${error.code})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

// CLEANUP INTERVALS

const cleanupExpiredTokens = async () => {
  try {
    const r = await executeQuery(
      "DELETE FROM signup_tokens WHERE UNIX_TIMESTAMP(expires_at)<=?",
      [Math.floor(Date.now() / 1000)],
    );
    if (r.affectedRows > 0)
      logger.info(`Cleaned ${r.affectedRows} expired signup tokens`);
  } catch (e) {
    logger.warn("Token cleanup failed:", e.message);
  }
};

const cleanupExpiredCodes = async () => {
  try {
    await executeQuery(
      "DELETE FROM password_resets WHERE expires_at<NOW() OR (used=1 AND created_at<DATE_SUB(NOW(),INTERVAL 24 HOUR))",
    );
  } catch (e) {
    logger.error("Reset code cleanup failed:", e);
  }
};

const tokenCleanupInterval = setInterval(cleanupExpiredTokens, 60 * 60 * 1000);
const codeCleanupInterval = setInterval(cleanupExpiredCodes, 60 * 60 * 1000);

/** Call this in your graceful-shutdown handler. */
const shutdown = () => {
  clearInterval(tokenCleanupInterval);
  clearInterval(codeCleanupInterval);
};

const clearPushTokens = (userId) =>
  executeQuery(
    `UPDATE users_tbl SET push_token=NULL,fcm_token=NULL,platform=NULL,device_token=NULL,device_token_type=NULL,updated_at=NOW() WHERE id=?`,
    [userId],
  );

async function insertAuditLog(
  action,
  req,
  {
    afpsn,
    firstname,
    lastname,
    sourceTable,
    recordNdx = null,
    oldData = null,
    newData = null,
  },
) {
  await executeQuery(
    `INSERT INTO audit_logs (action,source_table,performed_by_id,performed_by,record_ndx,afpsn,firstname,lastname,old_data,new_data)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      action,
      sourceTable ?? null,
      req.admin?.id ?? null,
      req.admin?.name ?? "unknown",
      recordNdx ?? null,
      afpsn ?? null,
      firstname ?? null,
      lastname ?? null,
      oldData ? JSON.stringify(oldData) : null,
      newData ? JSON.stringify(newData) : null,
    ],
  );
}

// ROUTES — INFO / HEALTH

router.get("/", (req, res) =>
  res.json({
    success: true,
    message: "Users API endpoint",
    availableEndpoints: [
      "POST /api/users/validate-identity",
      "POST /api/users/create-account",
      "POST /api/users/login",
      "GET  /api/users/health",
      "POST /api/users/logout",
      "POST /api/users/forgot-password",
      "POST /api/users/verify-reset-code",
      "POST /api/users/reset-password",
    ],
  }),
);

router.get("/health", async (req, res) => {
  const t = Date.now();
  try {
    const health = await healthCheck();
    if (health.status === "healthy") {
      return res.json({
        success: true,
        status: "healthy",
        ...health,
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    }
    res.status(503).json({
      success: false,
      status: "degraded",
      error: health.error,
      code: health.code ?? "HEALTH_CHECK_FAILED",
    });
  } catch (error) {
    logger.error("Health check error:", error);
    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: "Health check failed",
      code: error.code ?? "HEALTH_CHECK_ERROR",
    });
  }
});

// ============================================================
// VALIDATE IDENTITY
// ============================================================

router.post(
  "/validate-identity",
  identityLimiter,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    try {
      const {
        type,
        afpsn,
        bos,
        b_type,
        principal_first_name,
        principal_last_name,
        firstname,
        lastname,
        dob,
        claims_officer,
        guardian_firstname,
        guardian_lastname,
        guardian_email,
        guardian_relationship,
        guardian_contact,
      } = req.body;

      if (!type || !afpsn || !firstname || !lastname || !dob) {
        return res.status(400).json({
          success: false,
          error:
            "Type, AFP Serial Number, name, and date of birth are required",
          code: "MISSING_REQUIRED_FIELDS",
        });
      }
      if (!["P", "B"].includes(type)) {
        return res.status(400).json({
          success: false,
          error: "Invalid pensioner type",
          code: "INVALID_TYPE",
        });
      }
      if (type === "P" && !bos) {
        return res.status(400).json({
          success: false,
          error: "Branch of service required",
          code: "MISSING_BOS",
        });
      }
      if (
        type === "B" &&
        (!b_type || !principal_first_name || !principal_last_name)
      ) {
        return res.status(400).json({
          success: false,
          error: "Beneficiary information required",
          code: "MISSING_BENEFICIARY_INFO",
        });
      }

      // Minor check
      let isMinor = false;
      let guardianInfo = null;
      if (type === "B" && ["CH", "SB"].includes(b_type)) {
        const age = calculateAge(new Date(dob));
        if (age > 20) {
          return res.status(400).json({
            success: false,
            error: `${b_type === "CH" ? "Child" : "Sibling"} beneficiaries must be 20 years old or below`,
            code: "AGE_LIMIT_EXCEEDED",
            details: { currentAge: age, maxAge: 20, beneficiaryType: b_type },
          });
        }
        if (age <= 13) {
          isMinor = true;
          if (!guardian_firstname || !guardian_lastname || !guardian_email) {
            return res.status(400).json({
              success: false,
              error: "Guardian information required for minors (13 and below)",
              code: "GUARDIAN_INFO_REQUIRED",
              details: {
                beneficiaryAge: age,
                requiredFields: [
                  "guardian_firstname",
                  "guardian_lastname",
                  "guardian_email",
                ],
              },
            });
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardian_email)) {
            return res.status(400).json({
              success: false,
              error: "Invalid guardian email format",
              code: "INVALID_GUARDIAN_EMAIL",
            });
          }
          guardianInfo = {
            firstname: guardian_firstname.trim().toUpperCase(),
            lastname: guardian_lastname.trim().toUpperCase(),
            email: guardian_email.trim().toLowerCase(),
            relationship: guardian_relationship || null,
            contact: guardian_contact || null,
          };
        }
      }

      const normalizedAfpsn = afpsn.trim().toUpperCase();
      const normalizedAfpsnNumeric = normalizeAfpsnForMatching(normalizedAfpsn);
      const normalizedFirstname = firstname.trim().toUpperCase();
      const normalizedLastname = lastname.trim().toUpperCase();

      const afpsnMatchSql = normalizeAfpsnSql("AFPSN");

      // ── BENEFICIARY (Type B) ──────────────────────────────
      if (type === "B") {
        const normalizedPrincipalFirstname = principal_first_name
          .trim()
          .toUpperCase();
        const normalizedPrincipalLastname = principal_last_name
          .trim()
          .toUpperCase();

        // Check active beneficiary in heroes_tbl
        const existingInHeroes = await executeQuery(
          `SELECT NDX,FIRSTNAME,LASTNAME,AFPSN,DOB,TYPE,PENRANK,ACRANK FROM heroes_tbl
           WHERE UPPER(TRIM(FIRSTNAME))=? AND UPPER(TRIM(LASTNAME))=?
           AND DATE(DOB)=DATE(?) AND ${normalizeAfpsnSql("AFPSN")}=? AND TYPE='B'`,
          [
            normalizedFirstname,
            normalizedLastname,
            dob,
            normalizedAfpsnNumeric,
          ],
        );

        if (existingInHeroes.length > 0) {
          const heroData = existingInHeroes[0];
          const penRank = heroData.PENRANK?.trim().toUpperCase();
          const isOfficer = penRank ? OFFICER_RANKS.has(penRank) : false;

          if (claims_officer && !isOfficer)
            return res.status(400).json({
              success: false,
              error: `Rank mismatch: ${penRank}`,
              code: "INVALID_OFFICER_CLAIM",
              rank: penRank,
            });
          if (!claims_officer && isOfficer)
            return res.status(400).json({
              success: false,
              error: `You are linked to an officer rank (${penRank})`,
              code: "MISSING_OFFICER_CLAIM",
              rank: penRank,
            });

          const existingAccount = await executeQuery(
            `SELECT u.id FROM users_tbl u
             JOIN pensioners_tbl p ON u.pensioner_ndx=p.id
             WHERE p.hero_ndx=? AND p.source_table='heroes_tbl' AND p.type='B' AND u.account_status!='deleted'`,
            [heroData.NDX],
          );
          if (existingAccount.length > 0) {
            return res.status(409).json({
              success: false,
              error: "An account already exists for this beneficiary",
              code: "ACCOUNT_EXISTS",
              details: {
                afpsn: heroData.AFPSN,
                name: `${normalizedFirstname} ${normalizedLastname}`,
              },
            });
          }

          const tokenData = {
            type: "B",
            afpsn: heroData.AFPSN,
            bos: null,
            b_type,
            principal_afpsn: heroData.AFPSN,
            principal_first_name: normalizedPrincipalFirstname,
            principal_last_name: normalizedPrincipalLastname,
            principal_ndx: null,
            firstname: normalizedFirstname,
            lastname: normalizedLastname,
            dob,
            hero_ndx: heroData.NDX,
            penRank,
            acRank: heroData.ACRANK,
            isOfficer,
            account_status: "active",
            source_table: "heroes_tbl",
            is_minor: isMinor,
            guardian_info: guardianInfo,
            validated_at: new Date().toISOString(),
          };
          const { token } = generateValidationToken(tokenData);
          const identityToken = await storeValidationToken(token, tokenData);
          return res.json({
            success: true,
            message: isMinor
              ? "Active minor beneficiary identity verified. Guardian will manage account."
              : "Active beneficiary identity verified successfully",
            identityToken,
            heroData: {
              name: `${heroData.FIRSTNAME} ${heroData.LASTNAME}`,
              afpsn: heroData.AFPSN,
              principalName: `${normalizedPrincipalFirstname} ${normalizedPrincipalLastname}`,
              type: "B",
              beneficiaryType: b_type,
              dob: heroData.DOB,
              isMinor,
              guardianName: isMinor
                ? `${guardianInfo.firstname} ${guardianInfo.lastname}`
                : null,
              guardianEmail: isMinor ? guardianInfo.email : null,
            },
            data: {
              type: "B",
              afpsn: heroData.AFPSN,
              rank: penRank,
              isOfficer,
              account_status: "active",
              source_table: "heroes_tbl",
              isMinor,
            },
            meta: {
              processingTime: `${Date.now() - t}ms`,
              validUntil: new Date(
                Date.now() + TOKEN_EXPIRY_HOURS * 3600000,
              ).toISOString(),
            },
          });
        }

        // Verify principal pensioner
        const principalRecords = await executeQuery(
          `SELECT NDX,FIRSTNAME,LASTNAME,AFPSN,DOB,TYPE,PENRANK,ACRANK FROM heroes_tbl
           WHERE ${normalizeAfpsnSql("AFPSN")}=? AND UPPER(TRIM(FIRSTNAME))=? AND UPPER(TRIM(LASTNAME))=? AND TYPE='P'`,
          [
            normalizedAfpsnNumeric,
            normalizedPrincipalFirstname,
            normalizedPrincipalLastname,
          ],
        );
        if (principalRecords.length === 0) {
          return res.status(401).json({
            success: false,
            error: "Principal pensioner not found in active records.",
            code: "PRINCIPAL_NOT_FOUND",
          });
        }
        if (principalRecords.length > 1) {
          return res.status(409).json({
            success: false,
            error: "Multiple principal records found",
            code: "DUPLICATE_PRINCIPAL_RECORDS",
          });
        }
        const principalData = principalRecords[0];
        const penRank = principalData.PENRANK?.trim().toUpperCase();
        const isOfficer = penRank ? OFFICER_RANKS.has(penRank) : false;

        if (claims_officer && !isOfficer)
          return res.status(400).json({
            success: false,
            error: `Principal rank mismatch: ${penRank}`,
            code: "INVALID_OFFICER_CLAIM",
            rank: penRank,
          });
        if (!claims_officer && isOfficer)
          return res.status(400).json({
            success: false,
            error: `Principal pensioner is an officer (${penRank})`,
            code: "MISSING_OFFICER_CLAIM",
            rank: penRank,
          });

        const existingBeneficiary = await executeQuery(
          `SELECT u.id FROM users_tbl u
           JOIN pensioners_tbl p ON u.pensioner_ndx=p.id
           LEFT JOIN beneficiaries_table b ON p.hero_ndx=b.NDX
           WHERE UPPER(TRIM(b.FIRSTNAME))=? AND UPPER(TRIM(b.LASTNAME))=? AND DATE(b.DOB)=DATE(?)
           AND UPPER(TRIM(p.principal_firstname))=? AND UPPER(TRIM(p.principal_lastname))=?
           AND ${normalizeAfpsnSql("p.principal_afpsn")}=?
           AND p.b_type=? AND p.type='B' AND p.source_table='beneficiaries_table' AND u.account_status!='deleted'`,
          [
            normalizedFirstname,
            normalizedLastname,
            dob,
            normalizedPrincipalFirstname,
            normalizedPrincipalLastname,
            normalizedAfpsnNumeric,
            b_type,
          ],
        );
        if (existingBeneficiary.length > 0) {
          return res.status(409).json({
            success: false,
            error: "An account already exists for this beneficiary",
            code: "ACCOUNT_EXISTS",
          });
        }

        const tokenData = {
          type: "B",
          afpsn: normalizedAfpsn,
          bos: null,
          b_type,
          principal_ndx: principalData.NDX,
          principal_afpsn: principalData.AFPSN,
          principal_first_name: normalizedPrincipalFirstname,
          principal_last_name: normalizedPrincipalLastname,
          firstname: normalizedFirstname,
          lastname: normalizedLastname,
          dob,
          hero_ndx: null,
          penRank,
          acRank: principalData.ACRANK,
          isOfficer,
          account_status: "beneficiary_application",
          source_table: "beneficiaries_table",
          is_minor: isMinor,
          guardian_info: guardianInfo,
          validated_at: new Date().toISOString(),
        };
        const { token } = generateValidationToken(tokenData);
        const identityToken = await storeValidationToken(token, tokenData);
        return res.json({
          success: true,
          message: isMinor
            ? "Minor beneficiary application verified. Guardian will manage account. Pending approval."
            : "Beneficiary identity verified successfully",
          identityToken,
          heroData: {
            beneficiaryName: `${normalizedFirstname} ${normalizedLastname}`,
            principalName: `${principalData.FIRSTNAME} ${principalData.LASTNAME}`,
            principalAfpsn: principalData.AFPSN,
            type: "B",
            beneficiaryType: b_type,
            beneficiaryDob: dob,
            isMinor,
            guardianName: isMinor
              ? `${guardianInfo.firstname} ${guardianInfo.lastname}`
              : null,
            guardianEmail: isMinor ? guardianInfo.email : null,
          },
          data: {
            type: "B",
            principalAfpsn: normalizedAfpsn,
            rank: penRank,
            isOfficer,
            account_status: "beneficiary_application",
            source_table: "beneficiaries_table",
            isMinor,
          },
          meta: {
            processingTime: `${Date.now() - t}ms`,
            validUntil: new Date(
              Date.now() + TOKEN_EXPIRY_HOURS * 3600000,
            ).toISOString(),
          },
        });
      }

      // ── PRINCIPAL (Type P) ────────────────────────────────
      let detectedTable = null;
      let penRank = null;

      for (const tbl of ["heroes_tbl", "resumption_table"]) {
        const records = await executeQuery(
          `SELECT COUNT(*) AS cnt, PENRANK, AFPSN FROM ${safeTable(tbl)}
           WHERE ${normalizeAfpsnSql("AFPSN")}=? AND TYPE=? GROUP BY PENRANK,AFPSN`,
          [normalizedAfpsnNumeric, type],
        );
        if (records.length > 0) {
          detectedTable = tbl;
          penRank = records[0].PENRANK?.trim().toUpperCase();
          break;
        }
      }

      if (!detectedTable) {
        return res.status(401).json({
          success: false,
          error: "AFP Serial Number not found in our records",
          code: "AFPSN_NOT_FOUND",
        });
      }

      const account_status =
        detectedTable === "heroes_tbl" ? "active" : "resumption";
      const isOfficer = penRank ? OFFICER_RANKS.has(penRank) : false;

      if (claims_officer && !isOfficer)
        return res.status(400).json({
          success: false,
          error: `Rank mismatch: ${penRank}`,
          code: "INVALID_OFFICER_CLAIM",
          rank: penRank,
        });
      if (!claims_officer && isOfficer)
        return res.status(400).json({
          success: false,
          error: `You are an officer (${penRank})`,
          code: "MISSING_OFFICER_CLAIM",
          rank: penRank,
        });

      const heroes = await executeQuery(
        `SELECT NDX,FIRSTNAME,LASTNAME,AFPSN,DOB,TYPE,PENRANK,ACRANK FROM ${safeTable(detectedTable)}
         WHERE UPPER(TRIM(FIRSTNAME))=? AND UPPER(TRIM(LASTNAME))=? AND DATE(DOB)=DATE(?)
         AND ${normalizeAfpsnSql("AFPSN")}=? AND TYPE=?`,
        [
          normalizedFirstname,
          normalizedLastname,
          dob,
          normalizedAfpsnNumeric,
          type,
        ],
      );
      if (heroes.length === 0)
        return res.status(401).json({
          success: false,
          error: "Personal information mismatch",
          code: "PERSONAL_INFO_MISMATCH",
        });
      if (heroes.length > 1)
        return res.status(409).json({
          success: false,
          error: "Multiple records found",
          code: "DUPLICATE_RECORDS",
        });

      const heroData = heroes[0];

      const existingAccount = await executeQuery(
        `SELECT u.id FROM users_tbl u
         JOIN pensioners_tbl p ON u.pensioner_ndx=p.id
         LEFT JOIN ${safeTable(detectedTable)} h ON p.hero_ndx=h.NDX
         WHERE ${normalizeAfpsnSql("h.AFPSN")}=? AND UPPER(TRIM(h.FIRSTNAME))=? AND UPPER(TRIM(h.LASTNAME))=?
         AND p.source_table=? AND u.account_status!='deleted'`,
        [
          normalizedAfpsnNumeric,
          normalizedFirstname,
          normalizedLastname,
          detectedTable,
        ],
      );
      if (existingAccount.length > 0) {
        return res.status(409).json({
          success: false,
          error: "An account already exists for this person",
          code: "ACCOUNT_EXISTS",
          details: {
            afpsn: normalizedAfpsn,
            name: `${normalizedFirstname} ${normalizedLastname}`,
          },
        });
      }

      const tokenData = {
        type,
        afpsn: normalizedAfpsn,
        bos: type === "P" ? bos?.trim().toUpperCase() : null,
        b_type: null,
        principal_first_name: null,
        principal_last_name: null,
        firstname: normalizedFirstname,
        lastname: normalizedLastname,
        dob,
        hero_ndx: heroData.NDX,
        penRank,
        acRank: heroData.ACRANK,
        isOfficer,
        account_status,
        source_table: detectedTable,
        validated_at: new Date().toISOString(),
      };
      const { token } = generateValidationToken(tokenData);
      const identityToken = await storeValidationToken(token, tokenData);
      return res.json({
        success: true,
        message: "Identity verified successfully",
        identityToken,
        heroData: {
          name: `${heroData.FIRSTNAME} ${heroData.LASTNAME}`,
          afpsn: heroData.AFPSN,
          type: heroData.TYPE,
          dob: heroData.DOB,
        },
        data: {
          type,
          afpsn: normalizedAfpsn,
          rank: penRank,
          isOfficer,
          account_status,
          source_table: detectedTable,
        },
        meta: {
          processingTime: `${Date.now() - t}ms`,
          validUntil: new Date(
            Date.now() + TOKEN_EXPIRY_HOURS * 3600000,
          ).toISOString(),
        },
      });
    } catch (error) {
      logger.error("Identity validation error:", error);
      res.status(500).json({
        success: false,
        error: "Identity validation failed",
        code: "IDENTITY_VALIDATION_ERROR",
      });
    }
  },
);

// ============================================================
// CREATE ACCOUNT
// ============================================================

router.post(
  "/create-account",
  createAccountLimiter,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    let connection = null;
    try {
      const { identityToken, email, password: rawPassword } = req.body;
      if (!identityToken || !email || !rawPassword) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields",
          code: "MISSING_REQUIRED_FIELDS",
          details: {
            identityToken: !identityToken ? "missing" : "present",
            email: !email ? "missing" : "present",
            password: !rawPassword ? "missing" : "present",
          },
        });
      }

      const password = filterPassword(rawPassword);
      if (password !== rawPassword) {
        return res.status(400).json({
          success: false,
          error: "Password contains invalid characters",
          code: "INVALID_PASSWORD_CHARS",
        });
      }

      let validationData;
      try {
        validationData = await getValidationToken(identityToken);
        if (!validationData) throw new Error("Invalid validation data");
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: "Invalid or expired token",
          code: "INVALID_IDENTITY_TOKEN",
        });
      }

      // Minor email guard
      if (validationData.is_minor && validationData.guardian_info) {
        const guardianEmail = (validationData.guardian_info.email || "")
          .toLowerCase()
          .trim();
        const providedEmail = (email || "").toLowerCase().trim();
        if (!guardianEmail) {
          return res.status(400).json({
            success: false,
            error:
              "Guardian email not found in validation data. Please start over.",
            code: "GUARDIAN_EMAIL_MISSING",
          });
        }
        if (providedEmail !== guardianEmail) {
          return res.status(400).json({
            success: false,
            error: "Email must match guardian email from validation",
            code: "EMAIL_GUARDIAN_MISMATCH",
            details: { expectedEmail: guardianEmail, providedEmail },
          });
        }
      }

      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          error: "Invalid email format",
          code: "INVALID_EMAIL_FORMAT",
        });
      }
      const normalizedEmail = email.toLowerCase().trim();

      const existingEmail = await executeQuery(
        "SELECT id FROM users_tbl WHERE email=?",
        [normalizedEmail],
      );
      if (existingEmail.length > 0) {
        return res.status(409).json({
          success: false,
          error: "Email already exists",
          code: "EMAIL_ALREADY_EXISTS",
        });
      }

      const pwdCheck = validatePasswordStrength(password);
      if (!pwdCheck.isValid) {
        return res.status(400).json({
          success: false,
          error: "Weak password",
          details: pwdCheck.errors,
          code: "PASSWORD_TOO_WEAK",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      connection = await getConnection();

      const result = await retryWithBackoff(async () => {
        try {
          await connection.beginTransaction();

          let pensionerId;
          let beneficiaryNdx = null;
          let guardianId = null;

          if (validationData.type === "B") {
            if (validationData.source_table === "heroes_tbl") {
              const [heroCheck] = await connection.execute(
                "SELECT p.id FROM pensioners_tbl p WHERE p.hero_ndx=? AND p.source_table='heroes_tbl' AND p.type='B' FOR UPDATE",
                [validationData.hero_ndx],
              );
              if (heroCheck.length > 0) {
                pensionerId = heroCheck[0].id;
              } else {
                const [r] = await connection.execute(
                  `INSERT INTO pensioners_tbl (hero_ndx,source_table,type,bos,b_type,principal_afpsn,principal_firstname,principal_lastname)
                   VALUES (?,?,?,?,?,?,?,?)`,
                  [
                    validationData.hero_ndx,
                    "heroes_tbl",
                    "B",
                    null,
                    validationData.b_type || null,
                    validationData.principal_afpsn || null,
                    validationData.principal_first_name || null,
                    validationData.principal_last_name || null,
                  ],
                );
                pensionerId = r.insertId;
              }
            } else {
              // New beneficiary application
              const [existing] = await connection.execute(
                `SELECT p.id FROM pensioners_tbl p
                 LEFT JOIN beneficiaries_table b ON p.hero_ndx=b.NDX
                 WHERE UPPER(TRIM(b.FIRSTNAME))=? AND UPPER(TRIM(b.LASTNAME))=? AND DATE(b.DOB)=DATE(?)
                 AND UPPER(TRIM(p.principal_firstname))=? AND UPPER(TRIM(p.principal_lastname))=?
                 AND p.b_type=? AND p.type='B' AND p.source_table='beneficiaries_table' FOR UPDATE`,
                [
                  validationData.firstname,
                  validationData.lastname,
                  validationData.dob,
                  validationData.principal_first_name,
                  validationData.principal_last_name,
                  validationData.b_type,
                ],
              );
              if (existing.length > 0)
                throw Object.assign(
                  new Error("Account already exists for this beneficiary"),
                  { code: "RECORD_ALREADY_CLAIMED", statusCode: 409 },
                );

              const [bResult] = await connection.execute(
                "INSERT INTO beneficiaries_table (FIRSTNAME,LASTNAME,DOB,AFPSN,TYPE,PENRANK,ACRANK) VALUES (?,?,?,?,?,?,?)",
                [
                  validationData.firstname,
                  validationData.lastname,
                  validationData.dob,
                  validationData.afpsn || validationData.principal_afpsn,
                  "B",
                  validationData.penRank || null,
                  validationData.acRank || null,
                ],
              );
              beneficiaryNdx = bResult.insertId;
              if (!beneficiaryNdx)
                throw new Error("Failed to create beneficiary record");

              // [CRIT-4] Fixed: 9 columns, 9 placeholders
              const [pResult] = await connection.execute(
                `INSERT INTO pensioners_tbl (hero_ndx,source_table,type,bos,b_type,principal_afpsn,principal_firstname,principal_lastname,principal_ndx)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                  beneficiaryNdx,
                  "beneficiaries_table",
                  "B",
                  null,
                  validationData.b_type || null,
                  validationData.principal_afpsn || validationData.afpsn,
                  validationData.principal_first_name || null,
                  validationData.principal_last_name || null,
                  validationData.principal_ndx || null,
                ],
              );
              pensionerId = pResult.insertId;
              if (!pensionerId)
                throw new Error("Failed to create pensioner record");
            }
          } else {
            // Principal
            const [heroCheck] = await connection.execute(
              "SELECT p.id FROM pensioners_tbl p WHERE p.hero_ndx=? AND p.source_table=? AND p.type='P' FOR UPDATE",
              [validationData.hero_ndx, validationData.source_table],
            );
            if (heroCheck.length > 0) {
              pensionerId = heroCheck[0].id;
            } else {
              const [r] = await connection.execute(
                "INSERT INTO pensioners_tbl (hero_ndx,source_table,type,bos) VALUES (?,?,?,?)",
                [
                  validationData.hero_ndx,
                  validationData.source_table,
                  "P",
                  validationData.bos || null,
                ],
              );
              pensionerId = r.insertId;
            }
          }

          let initialUserStatus;
          if (validationData.type === "B") {
            initialUserStatus =
              validationData.source_table === "heroes_tbl" ? "TAG" : "AFB";
          } else {
            initialUserStatus =
              validationData.account_status === "resumption" ? "AFR" : "TAG";
          }

          const [userResult] = await connection.execute(
            "INSERT INTO users_tbl (pensioner_ndx,email,password_hash,status,tagged_at) VALUES (?,?,?,?,NOW())",
            [pensionerId, normalizedEmail, hashedPassword, initialUserStatus],
          );
          const userId = userResult.insertId;
          if (!userId) throw new Error("Failed to create user");

          if (validationData.is_minor && validationData.guardian_info) {
            const [gr] = await connection.execute(
              "INSERT INTO guardians_tbl (pensioner_ndx,firstname,lastname,email,contact_number,relationship) VALUES (?,?,?,?,?,?)",
              [
                pensionerId,
                validationData.guardian_info.firstname,
                validationData.guardian_info.lastname,
                validationData.guardian_info.email,
                validationData.guardian_info.contact || null,
                validationData.guardian_info.relationship || null,
              ],
            );
            guardianId = gr.insertId;
            if (!guardianId)
              throw new Error("Failed to create guardian record");
          }

          await connection.execute("DELETE FROM signup_tokens WHERE token=?", [
            identityToken,
          ]);
          await connection.commit();

          return {
            userId,
            pensionerId,
            beneficiaryNdx,
            guardianId,
            email: normalizedEmail,
            status: initialUserStatus,
            account_status: validationData.account_status,
            type: validationData.type,
            isMinor: validationData.is_minor || false,
            hasGuardian: !!guardianId,
          };
        } catch (err) {
          try {
            await connection.rollback();
          } catch {}
          throw err;
        }
      });

      let message;
      if (validationData.type === "B") {
        if (validationData.source_table === "heroes_tbl") {
          message = validationData.is_minor
            ? "Minor beneficiary account created. Guardian will manage this account."
            : "Active beneficiary account created successfully";
        } else {
          message = validationData.is_minor
            ? "Minor beneficiary application submitted with guardian. Pending approval."
            : "Beneficiary application submitted. Pending approval.";
        }
      } else {
        message =
          validationData.account_status === "resumption"
            ? "Account created. Pending approval for resumption."
            : "Account created successfully";
      }

      res.status(201).json({
        success: true,
        message,
        data: result,
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Account creation error:", error);
      let statusCode = 500,
        errorCode = "ACCOUNT_CREATION_FAILED",
        errorMessage = "Account creation failed";
      if (error.code === "ER_DUP_ENTRY") {
        statusCode = 409;
        errorCode = "DUPLICATE_ENTRY";
        errorMessage = "Account already exists";
      } else if (error.code === "RECORD_ALREADY_CLAIMED") {
        statusCode = error.statusCode;
        errorCode = error.code;
        errorMessage = error.message;
      } else if (error.code === "ER_LOCK_DEADLOCK") {
        statusCode = 409;
        errorCode = "CONCURRENT_REQUEST";
        errorMessage = "Another registration in progress. Please try again.";
      } else if (error.code === "DB_CONNECTION_FAILED") {
        statusCode = 503;
        errorCode = "DB_CONNECTION_FAILED";
        errorMessage = "Database connection failed. Please try again later.";
      }
      res.status(statusCode).json({
        success: false,
        error: errorMessage,
        code: errorCode,
        processingTime: `${Date.now() - t}ms`,
      });
    } finally {
      if (connection) {
        try {
          connection.release();
        } catch {}
      }
    }
  },
);

// ============================================================
// LOGIN
// ============================================================

router.post(
  "/login",
  loginLimiter,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    try {
      const { email, password } = req.body;
      if (!email || !password)
        return res.status(400).json({
          success: false,
          error: "Email and password required",
          code: "MISSING_CREDENTIALS",
        });
      if (!validator.isEmail(email))
        return res.status(400).json({
          success: false,
          error: "Invalid email",
          code: "INVALID_EMAIL",
        });

      const normalizedEmail = email.toLowerCase().trim();
      const users = await executeQuery(
        `SELECT u.id AS user_id, u.email, u.password_hash, u.status AS user_status, u.account_status, u.token_version,
                p.id AS pensioner_id, p.type, p.b_type, p.bos, p.source_table,
                COALESCE(h.FIRSTNAME,h2.FIRSTNAME,h3.FIRSTNAME) AS FIRSTNAME,
                COALESCE(h.LASTNAME,h2.LASTNAME,h3.LASTNAME) AS LASTNAME,
                COALESCE(h.AFPSN,h2.AFPSN,h3.AFPSN) AS AFPSN
         FROM users_tbl u
         JOIN pensioners_tbl p ON u.pensioner_ndx=p.id
         LEFT JOIN heroes_tbl h ON p.hero_ndx=h.NDX AND p.source_table='heroes_tbl'
         LEFT JOIN resumption_table h2 ON p.hero_ndx=h2.NDX AND p.source_table='resumption_table'
         LEFT JOIN beneficiaries_table h3 ON p.hero_ndx=h3.NDX AND p.source_table='beneficiaries_table'
         WHERE u.email=? LOCK IN SHARE MODE`,
        [normalizedEmail],
      );

      if (users.length === 0)
        return res.status(401).json({
          success: false,
          error: "Invalid credentials",
          code: "INVALID_CREDENTIALS",
        });
      const user = users[0];
      if (user.user_status === "SUS")
        return res.status(403).json({
          success: false,
          error: "Account suspended",
          code: "ACCOUNT_SUSPENDED",
        });

      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch)
        return res.status(401).json({
          success: false,
          error: "Invalid credentials",
          code: "INVALID_CREDENTIALS",
        });

      if (user.account_status === "deactivated") {
        executeQuery(
          "UPDATE users_tbl SET account_status='active',updated_at=NOW() WHERE id=?",
          [user.user_id],
        ).catch((e) => logger.warn("Reactivation failed:", e));
      }
      executeQuery("UPDATE users_tbl SET last_login=NOW() WHERE id=?", [
        user.user_id,
      ]).catch((e) => logger.warn("last_login update failed:", e));

      const token = jwt.sign(
        {
          userId: user.user_id,
          email: user.email,
          type: user.type,
          tokenVersion: user.token_version,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" },
      );

      res.json({
        success: true,
        message:
          user.account_status === "deactivated"
            ? "Login successful. Your account has been reactivated."
            : "Login successful",
        token,
        user: {
          id: user.user_id,
          email: user.email,
          pensioner_id: user.pensioner_id,
          type: user.type,
          b_type: user.b_type,
          status: "ACTIVE",
          account_status:
            user.account_status === "deactivated"
              ? "active"
              : user.account_status,
          validated_hero: {
            name: `${user.FIRSTNAME} ${user.LASTNAME}`,
            afpsn: user.AFPSN,
          },
        },
        meta: {
          processingTime: `${Date.now() - t}ms`,
          loginTime: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Login error:", error);
      res
        .status(500)
        .json({ success: false, error: "Login failed", code: "SERVICE_ERROR" });
    }
  },
);

// ============================================================
// LOGOUT
// ============================================================
router.post(
  "/logout",
  authenticateToken,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    const token = req.headers["authorization"].split(" ")[1];
    try {
      const { userId } = req.body;
      if (!userId)
        return res.status(400).json({
          success: false,
          error: "User ID is required",
          code: "MISSING_USER_ID",
        });

      await executeQuery(
        "INSERT INTO token_blacklist (token,expires_at) VALUES (?,DATE_ADD(NOW(),INTERVAL 7 DAY))",
        [token],
      );
      blacklistCache.set(token, true);
      await clearPushTokens(userId);

      res.json({
        success: true,
        message: "Logged out successfully",
        meta: {
          logoutTime: new Date().toISOString(),
          processingTime: `${Date.now() - t}ms`,
        },
      });
    } catch (error) {
      logger.error("Logout error:", error);
      res
        .status(500)
        .json({ success: false, error: "Logout failed", code: "LOGOUT_ERROR" });
    }
  },
);

// PROFILE
router.get(
  "/profile/:userId",
  authenticateToken,
  validateDatabaseConnection,
  async (req, res) => {
    const isAdmin = req.user?.type === "admin";
    if (!isAdmin && req.user.userId !== parseInt(req.params.userId)) {
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    }
    const t = Date.now();
    try {
      const { userId } = req.params;
      const pensionerInfo = await executeQuery(
        "SELECT p.id,p.hero_ndx,p.source_table,p.type,p.bos,p.b_type,p.principal_firstname,p.principal_lastname FROM users_tbl u JOIN pensioners_tbl p ON u.pensioner_ndx=p.id WHERE u.id=? LIMIT 1",
        [userId],
      );
      if (pensionerInfo.length === 0)
        return res.status(404).json({
          success: false,
          error: "Pensioner record not found",
          code: "PENSIONER_NOT_FOUND",
        });

      const pensioner = pensionerInfo[0];
      const sourceTable = safeTable(pensioner.source_table || "heroes_tbl"); // [CRIT-1]

      const userProfile = await executeQuery(
        `SELECT u.id AS user_id,u.email,u.status,u.home_address,u.created_at,u.last_login,u.device_token_type,u.updated_at,u.profile_picture,u.pensioner_ndx AS pensioner_id,
                p.type,p.bos,p.b_type,p.source_table,p.principal_firstname,p.principal_lastname,
                h.FIRSTNAME,h.LASTNAME,h.AFPSN,h.DOB,h.MOBILENR,h.CTRLNR,h.PENRANK,h.ACRANK
         FROM users_tbl u
         JOIN pensioners_tbl p ON u.pensioner_ndx=p.id
         JOIN ${sourceTable} h ON p.hero_ndx=h.NDX
         WHERE u.id=? LIMIT 1`,
        [userId],
      );
      if (userProfile.length === 0)
        return res.status(404).json({
          success: false,
          error: "User profile not found",
          code: "PROFILE_NOT_FOUND",
        });

      const profile = userProfile[0];
      const formattedAFPSN = formatAfpsn(profile.AFPSN, profile.PENRANK);

      res.json({
        success: true,
        user_id: profile.user_id,
        EMAIL: profile.email,
        home_address: profile.home_address,
        profile_picture: profile.profile_picture,
        pensioner_id: profile.pensioner_id,
        status: profile.status,
        FIRSTNAME: profile.FIRSTNAME,
        LASTNAME: profile.LASTNAME,
        AFPSN: formattedAFPSN,
        DOB: profile.DOB,
        MOBILENR: profile.MOBILENR,
        BOS: profile.bos,
        TYPE: profile.type,
        SOURCE_TABLE: profile.source_table,
        CTRLNR: profile.CTRLNR,
        ACRANK: profile.ACRANK,
        PENRANK: profile.PENRANK,
        ...(profile.type === "B" && {
          b_type: profile.b_type,
          PRINCIPAL_FIRSTNAME: profile.principal_firstname,
          PRINCIPAL_LASTNAME: profile.principal_lastname,
        }),
        created_at: profile.created_at,
        last_login: profile.last_login,
        device_token_type: profile.device_token_type,
        updated_at: profile.updated_at,
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
          sourceTable,
        },
      });
    } catch (error) {
      logger.error("Profile fetch error:", error);
      const isTableError = error.code === "INVALID_TABLE";
      res.status(isTableError ? 400 : 500).json({
        success: false,
        error: isTableError ? error.message : "Failed to fetch profile",
        code: isTableError ? "INVALID_SOURCE_TABLE" : "PROFILE_FETCH_ERROR",
      });
    }
  },
);

// ============================================================
// PROFILE UPDATE ROUTES
// ============================================================

router.put(
  "/update-email/:userId",
  profileUpdateLimiter,
  authenticateToken,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.userId))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    try {
      const { userId } = req.params;
      const { email, password } = req.body;
      if (!email || !password)
        return res.status(400).json({
          success: false,
          error: "Email and password are required",
          code: "MISSING_FIELDS",
        });
      if (!validator.isEmail(email))
        return res.status(400).json({
          success: false,
          error: "Please enter a valid email address",
          code: "INVALID_EMAIL",
        });

      const normalizedEmail = email.toLowerCase().trim();
      const userCheck = await executeQuery(
        "SELECT id,email,password_hash FROM users_tbl WHERE id=? LIMIT 1",
        [userId],
      );
      if (userCheck.length === 0)
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });

      if (!(await bcrypt.compare(password, userCheck[0].password_hash))) {
        return res.status(401).json({
          success: false,
          error: "Incorrect password",
          code: "INVALID_PASSWORD",
        });
      }
      const emailExists = await executeQuery(
        "SELECT id FROM users_tbl WHERE email=? AND id!=? LIMIT 1",
        [normalizedEmail, userId],
      );
      if (emailExists.length > 0)
        return res.status(409).json({
          success: false,
          error: "This email is already in use by another account",
          code: "EMAIL_EXISTS",
        });

      await executeQuery(
        "UPDATE users_tbl SET email=?,updated_at=NOW() WHERE id=?",
        [normalizedEmail, userId],
      );
      res.json({
        success: true,
        message: "Email updated successfully",
        data: { email: normalizedEmail },
        meta: {
          processingTime: `${Date.now() - t}ms`,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Email update error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update email.",
        code: "EMAIL_UPDATE_ERROR",
      });
    }
  },
);

router.put(
  "/update-password/:userId",
  profileUpdateLimiter,
  authenticateToken,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.userId))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    try {
      const { userId } = req.params;
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword)
        return res.status(400).json({
          success: false,
          error: "Current password and new password are required",
          code: "MISSING_PASSWORDS",
        });

      const filtered = filterPassword(newPassword);
      if (filtered !== newPassword)
        return res.status(400).json({
          success: false,
          error: "New password contains invalid characters",
          code: "INVALID_PASSWORD_CHARS",
        });

      const pwdCheck = validatePasswordStrength(filtered);
      if (!pwdCheck.isValid)
        return res.status(400).json({
          success: false,
          error: "New password does not meet security requirements",
          details: pwdCheck.errors,
          code: "WEAK_PASSWORD",
        });

      const users = await executeQuery(
        "SELECT id,email,password_hash FROM users_tbl WHERE id=? LIMIT 1",
        [userId],
      );
      if (users.length === 0)
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });

      if (!(await bcrypt.compare(currentPassword, users[0].password_hash))) {
        return res.status(401).json({
          success: false,
          error: "Current password is incorrect",
          code: "INCORRECT_PASSWORD",
        });
      }
      await executeQuery(
        "UPDATE users_tbl SET password_hash=?,updated_at=NOW() WHERE id=?",
        [await bcrypt.hash(filtered, 12), userId],
      );
      res.json({
        success: true,
        message: "Password updated successfully",
        meta: {
          processingTime: `${Date.now() - t}ms`,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Password update error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update password.",
        code: "PASSWORD_UPDATE_ERROR",
      });
    }
  },
);

router.put(
  "/update-mobile/:userId",
  profileUpdateLimiter,
  authenticateToken,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.userId))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    try {
      const { userId } = req.params;
      const { mobile } = req.body;
      if (!mobile)
        return res.status(400).json({
          success: false,
          error: "Mobile number is required",
          code: "MISSING_MOBILE",
        });

      const normalizedMobile = mobile.trim();
      if (!/^[0-9+\-\s()]{10,15}$/.test(normalizedMobile)) {
        return res.status(400).json({
          success: false,
          error: "Please enter a valid mobile number (10-15 digits)",
          code: "INVALID_MOBILE",
        });
      }

      const userCheck = await executeQuery(
        "SELECT id FROM users_tbl WHERE id=? LIMIT 1",
        [userId],
      );
      if (userCheck.length === 0)
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });

      const pensionerData = await executeQuery(
        "SELECT p.hero_ndx,p.id AS pensioner_id,p.source_table,p.type FROM pensioners_tbl p JOIN users_tbl u ON u.pensioner_ndx=p.id WHERE u.id=? LIMIT 1",
        [userId],
      );
      if (pensionerData.length === 0)
        return res.status(404).json({
          success: false,
          error: "Pensioner record not found",
          code: "PENSIONER_NOT_FOUND",
        });

      const { hero_ndx, source_table, type } = pensionerData[0];
      const tbl = safeTable(source_table);

      const updateResult = await executeQuery(
        `UPDATE ${tbl} SET MOBILENR=? WHERE NDX=?`,
        [normalizedMobile, hero_ndx],
      );
      if (updateResult.affectedRows === 0) {
        return res.status(500).json({
          success: false,
          error: `Failed to update mobile number — record not found in ${tbl}`,
          code: "UPDATE_FAILED",
        });
      }

      res.json({
        success: true,
        message: "Mobile number updated successfully",
        data: {
          mobile: normalizedMobile,
          heroNdx: hero_ndx,
          sourceTable: tbl,
          userType: type,
        },
        meta: {
          processingTime: `${Date.now() - t}ms`,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Mobile update error:", error);
      const isTableError = error.code === "INVALID_TABLE";
      res.status(isTableError ? 400 : 500).json({
        success: false,
        error: isTableError ? error.message : "Failed to update mobile number.",
        code: isTableError ? "INVALID_SOURCE_TABLE" : "MOBILE_UPDATE_ERROR",
      });
    }
  },
);

// ============================================================
// PASSWORD RESET
// ============================================================

router.post(
  "/forgot-password",
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    let connection = null;
    try {
      const { email } = req.body;
      if (!email)
        return res.status(400).json({
          success: false,
          error: "Email is required",
          code: "EMAIL_REQUIRED",
        });
      if (!validator.isEmail(email))
        return res.status(400).json({
          success: false,
          error: "Invalid email format",
          code: "INVALID_EMAIL_FORMAT",
        });

      const normalizedEmail = email.toLowerCase().trim();
      const users = await executeQuery(
        "SELECT id,email FROM users_tbl WHERE email=? AND deleted_at IS NULL",
        [normalizedEmail],
      );

      // Always return 200 to prevent email enumeration
      const genericOk = {
        success: true,
        message:
          "If an account exists with this email, a reset code has been sent.",
        processingTime: `${Date.now() - t}ms`,
      };
      if (users.length === 0) return res.status(200).json(genericOk);

      const user = users[0];
      connection = await getConnection();
      try {
        await connection.beginTransaction();

        const [recent] = await connection.execute(
          "SELECT created_at FROM password_resets WHERE user_id=? AND created_at>DATE_SUB(NOW(),INTERVAL 1 MINUTE) ORDER BY created_at DESC LIMIT 1",
          [user.id],
        );
        if (recent.length > 0) {
          await connection.rollback();
          return res.status(429).json({
            success: false,
            error: "Please wait 1 minute before requesting another code",
            code: "RATE_LIMITED",
          });
        }

        await connection.execute(
          "UPDATE password_resets SET used=1 WHERE user_id=? AND used=0",
          [user.id],
        );
        const resetCode = crypto.randomInt(10000, 99999).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await connection.execute(
          "INSERT INTO password_resets (user_id,code,expires_at) VALUES (?,?,?)",
          [user.id, resetCode, expiresAt],
        );
        await connection.commit();

        transporter
          .sendMail({
            from: process.env.SMTP_FROM,
            to: user.email,
            subject: "Password Reset Code",
            html: buildEmailHtml("reset", { code: resetCode }),
          })
          .then((info) => logger.info("Reset email sent:", info.messageId))
          .catch((err) => logger.error("Reset email failed:", err.message));

        return res.status(200).json(genericOk);
      } catch (e) {
        await connection.rollback();
        throw e;
      }
    } catch (error) {
      logger.error("Forgot password error:", error);
      res.status(500).json({
        success: false,
        error: "Unable to process password reset request",
        code: "PASSWORD_RESET_FAILED",
      });
    } finally {
      if (connection) {
        try {
          connection.release();
        } catch {}
      }
    }
  },
);

/**
 * Returns a short-lived signed token instead; reset-password validates that token.
 */
router.post(
  "/verify-reset-code",
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    try {
      const { email, code } = req.body;
      if (!email || !code)
        return res.status(400).json({
          success: false,
          error: "Email and code are required",
          code: "MISSING_FIELDS",
        });

      const normalizedEmail = email.toLowerCase().trim();
      const resets = await executeQuery(
        `SELECT pr.id,pr.user_id,pr.expires_at FROM password_resets pr
         JOIN users_tbl u ON pr.user_id=u.id
         WHERE u.email=? AND pr.code=? AND pr.used=0
         ORDER BY pr.created_at DESC LIMIT 1`,
        [normalizedEmail, code],
      );
      if (resets.length === 0)
        return res.status(400).json({
          success: false,
          error: "Invalid or expired reset code",
          code: "INVALID_CODE",
        });

      const reset = resets[0];
      if (new Date() > new Date(reset.expires_at)) {
        return res.status(400).json({
          success: false,
          error: "Reset code has expired",
          code: "CODE_EXPIRED",
        });
      }

      // Return an opaque signed token (5-minute TTL) — no internal IDs exposed
      const verifiedToken = jwt.sign(
        { resetId: reset.id, userId: reset.user_id },
        process.env.JWT_SECRET,
        { expiresIn: "5m" },
      );

      res.status(200).json({
        success: true,
        message: "Code verified successfully",
        verifiedToken,
        processingTime: `${Date.now() - t}ms`,
      });
    } catch (error) {
      logger.error("Verify code error:", error);
      res.status(500).json({
        success: false,
        error: "Unable to verify reset code",
        code: "VERIFICATION_FAILED",
      });
    }
  },
);

router.post(
  "/reset-password",
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    const t = Date.now();
    let connection = null;
    try {
      const { verifiedToken, newPassword } = req.body;
      if (!verifiedToken || !newPassword) {
        return res.status(400).json({
          success: false,
          error: "verifiedToken and new password are required",
          code: "MISSING_FIELDS",
        });
      }

      const filtered = filterPassword(newPassword);
      if (filtered !== newPassword)
        return res.status(400).json({
          success: false,
          error: "Password contains invalid characters",
          code: "INVALID_PASSWORD_CHARS",
        });

      const pwdCheck = validatePasswordStrength(filtered);
      if (!pwdCheck.isValid)
        return res.status(400).json({
          success: false,
          error: "Weak password",
          details: pwdCheck.errors,
          code: "PASSWORD_TOO_WEAK",
        });

      let payload;
      try {
        payload = jwt.verify(verifiedToken, process.env.JWT_SECRET);
      } catch {
        return res.status(400).json({
          success: false,
          error: "Invalid or expired verification token",
          code: "INVALID_VERIFIED_TOKEN",
        });
      }

      connection = await getConnection();
      try {
        await connection.beginTransaction();

        const [resets] = await connection.execute(
          "SELECT pr.id,pr.expires_at,u.email,u.password_hash FROM password_resets pr JOIN users_tbl u ON pr.user_id=u.id WHERE pr.id=? AND pr.used=0 FOR UPDATE",
          [payload.resetId],
        );
        if (resets.length === 0) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            error: "Invalid or expired reset code",
            code: "INVALID_CODE",
          });
        }

        const reset = resets[0];
        if (new Date() > new Date(reset.expires_at)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            error: "Reset code has expired",
            code: "CODE_EXPIRED",
          });
        }
        if (await bcrypt.compare(filtered, reset.password_hash)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            error: "New password must be different from your current password",
            code: "SAME_PASSWORD",
          });
        }

        const userEmail = reset.email;
        await connection.execute(
          "UPDATE users_tbl SET password_hash=?,updated_at=NOW() WHERE id=?",
          [await bcrypt.hash(filtered, 12), payload.userId],
        );
        await connection.execute(
          "UPDATE password_resets SET used=1 WHERE id=?",
          [reset.id],
        );
        await connection.commit();

        transporter
          .sendMail({
            from: `"AFP Pension and Gratuity Management Center" <${process.env.SMTP_FROM}>`,
            to: userEmail,
            subject: "Password Successfully Changed",
            html: buildEmailHtml("reset_confirm"),
          })
          .then((info) =>
            logger.info("Password change confirmation sent:", info.messageId),
          )
          .catch((err) => logger.error("Confirmation email failed:", err));

        res.status(200).json({
          success: true,
          message: "Password reset successfully",
          processingTime: `${Date.now() - t}ms`,
        });
      } catch (e) {
        try {
          await connection.rollback();
        } catch {}
        throw e;
      }
    } catch (error) {
      logger.error("Reset password error:", error);
      res.status(500).json({
        success: false,
        error: "Unable to reset password",
        code: "PASSWORD_RESET_FAILED",
      });
    } finally {
      if (connection) {
        try {
          connection.release();
        } catch {}
      }
    }
  },
);

// ACCOUNT DELETION / DEACTIVATION

router.delete(
  "/delete-account/:id",
  authenticateToken,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.id))
      return res.status(403).json({
        success: false,
        error: "You can only delete your own account",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    let connection = null;
    try {
      const { id } = req.params;
      const { password, reason } = req.body;
      if (!password || !reason)
        return res.status(400).json({
          success: false,
          error: "Password and reason are required",
          code: "MISSING_FIELDS",
        });

      connection = await getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute(
          "SELECT id,pensioner_ndx,email,password_hash FROM users_tbl WHERE id=? AND account_status!='deleted'",
          [id],
        );
        if (users.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            error: "User not found",
            code: "USER_NOT_FOUND",
          });
        }

        const user = users[0];
        if (!(await bcrypt.compare(password, user.password_hash))) {
          await connection.rollback();
          return res.status(401).json({
            success: false,
            error: "Incorrect password",
            code: "INVALID_PASSWORD",
          });
        }
        await connection.execute(
          "INSERT INTO account_deletion_logs (user_id,pensioner_ndx,email,reason,deleted_at) VALUES (?,?,?,?,NOW())",
          [user.id, user.pensioner_ndx, user.email, reason],
        );
        await connection.execute(
          "DELETE hl FROM history_logs hl INNER JOIN form_submission fs ON hl.form_submission_id=fs.id WHERE fs.user_id=?",
          [id],
        );
        await connection.execute(
          "DELETE FROM form_submission WHERE user_id=?",
          [id],
        );
        await connection.execute("DELETE FROM users_tbl WHERE id=?", [id]);
        await connection.commit();

        transporter
          .sendMail({
            from: `"AFP Pension and Gratuity Management Center" <${process.env.SMTP_FROM}>`,
            to: user.email,
            subject: "Account Deleted - AFPPGMC Heroes Mobile App",
            html: buildEmailHtml("delete"),
          })
          .then((info) =>
            logger.info("Account deletion email sent:", info.messageId),
          )
          .catch((err) => logger.error("Account deletion email failed:", err));

        res.status(200).json({
          success: true,
          message: "Account deleted successfully",
          processingTime: `${Date.now() - t}ms`,
        });
      } catch (e) {
        try {
          await connection.rollback();
        } catch {}
        throw e;
      }
    } catch (error) {
      logger.error("Delete account error:", error);
      res.status(500).json({
        success: false,
        error: "Unable to delete account",
        code: "DELETE_ACCOUNT_FAILED",
      });
    } finally {
      if (connection) {
        try {
          connection.release();
        } catch {}
      }
    }
  },
);

router.put(
  "/deactivate-account/:id",
  authenticateToken,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.id))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    let connection = null;
    try {
      const { id } = req.params;
      const { password, reason } = req.body;

      const sanitizedReason =
        typeof reason === "string" ? reason.trim().slice(0, 200) : null;

      if (!password || !sanitizedReason)
        return res.status(400).json({
          success: false,
          error: "Password and reason are required",
          code: "MISSING_FIELDS",
        });

      connection = await getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute(
          "SELECT id,email,password_hash FROM users_tbl WHERE id=? AND account_status NOT IN ('deleted','deactivated')",
          [id],
        );
        if (users.length === 0) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            error: "User not found",
            code: "USER_NOT_FOUND",
          });
        }

        const user = users[0];
        if (!(await bcrypt.compare(password, user.password_hash))) {
          await connection.rollback();
          return res.status(401).json({
            success: false,
            error: "Incorrect password",
            code: "INVALID_PASSWORD",
          });
        }
        await connection.execute(
          "UPDATE users_tbl SET account_status='deactivated', deactivation_reason=?, updated_at=NOW() WHERE id=?",
          [sanitizedReason, id],
        );

        await connection.commit();

        transporter
          .sendMail({
            from: `"AFP Pension and Gratuity Management Center" <${process.env.SMTP_FROM}>`,
            to: user.email,
            subject: "Account Deactivated",
            html: buildEmailHtml("deactivate"),
          })
          .then((info) =>
            logger.info("Deactivation email sent:", info.messageId),
          )
          .catch((err) => logger.error("Deactivation email failed:", err));

        res.status(200).json({
          success: true,
          message: "Account deactivated successfully",
          processingTime: `${Date.now() - t}ms`,
        });
      } catch (e) {
        try {
          await connection.rollback();
        } catch {}
        throw e;
      }
    } catch (error) {
      logger.error("Deactivate account error:", error);
      res.status(500).json({
        success: false,
        error: "Unable to deactivate account",
        code: "DEACTIVATE_ACCOUNT_FAILED",
      });
    } finally {
      if (connection) {
        try {
          connection.release();
        } catch {}
      }
    }
  },
);

// PASSWORD VERIFY

router.post(
  "/verify-password/:userId",
  verifyPasswordLimiter,
  authenticateToken,
  sanitizeInput,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.userId))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    try {
      const { userId } = req.params;
      const { password } = req.body;
      if (!password)
        return res.status(400).json({
          success: false,
          error: "Password is required",
          code: "MISSING_PASSWORD",
        });

      const users = await executeQuery(
        "SELECT id,password_hash,status FROM users_tbl WHERE id=? AND account_status!='deleted' LIMIT 1",
        [userId],
      );
      if (users.length === 0)
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });
      if (users[0].status === "SUS")
        return res.status(403).json({
          success: false,
          error: "Account suspended",
          code: "ACCOUNT_SUSPENDED",
        });

      if (!(await bcrypt.compare(password, users[0].password_hash))) {
        return res.status(401).json({
          success: false,
          error: "Incorrect password",
          code: "INVALID_PASSWORD",
        });
      }
      res.json({
        success: true,
        message: "Password verified",
        processingTime: `${Date.now() - t}ms`,
      });
    } catch (error) {
      logger.error("Verify password error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to verify password",
        code: "VERIFY_PASSWORD_ERROR",
      });
    }
  },
);

// PUSH TOKENS

router.post(
  "/:userId/push-token",
  pushTokenLimiter,
  sanitizeInput,
  authenticateToken,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.userId))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    try {
      const { userId } = req.params;
      const {
        push_token,
        fcm_token,
        platform,
        device_token,
        device_token_type,
      } = req.body;

      if (!push_token && !fcm_token)
        return res.status(400).json({
          success: false,
          error: "At least one push token is required",
          code: "MISSING_PUSH_TOKEN",
        });
      if (
        push_token &&
        !/^ExponentPushToken\[[a-zA-Z0-9_-]+\]$/.test(push_token)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid Expo push token format",
          code: "INVALID_TOKEN_FORMAT",
        });
      }

      const userCheck = await executeQuery(
        "SELECT id FROM users_tbl WHERE id=? LIMIT 1",
        [userId],
      );
      if (userCheck.length === 0)
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });

      await executeQuery(
        "UPDATE users_tbl SET push_token=COALESCE(?,push_token),fcm_token=COALESCE(?,fcm_token),platform=?,device_token=?,device_token_type=?,updated_at=NOW() WHERE id=?",
        [
          push_token || null,
          fcm_token || null,
          platform || null,
          device_token || null,
          device_token_type || null,
          userId,
        ],
      );
      res.json({
        success: true,
        message: "Push tokens saved successfully",
        tokens: { expo: !!push_token, fcm: !!fcm_token, platform },
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Push token update error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to save push token",
        code: "PUSH_TOKEN_ERROR",
      });
    }
  },
);

router.delete(
  "/:userId/push-token",
  pushTokenLimiter,
  sanitizeInput,
  authenticateToken,
  validateDatabaseConnection,
  async (req, res) => {
    if (req.user.userId !== parseInt(req.params.userId))
      return res.status(403).json({
        success: false,
        error: "You can only access your own profile",
        code: "FORBIDDEN",
      });
    const t = Date.now();
    try {
      const { userId } = req.params;
      const userCheck = await executeQuery(
        "SELECT id FROM users_tbl WHERE id=? LIMIT 1",
        [userId],
      );
      if (userCheck.length === 0)
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });

      await clearPushTokens(userId);
      res.json({
        success: true,
        message: "Push tokens removed successfully",
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Push token removal error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to remove push tokens",
        code: "PUSH_TOKEN_DELETE_ERROR",
      });
    }
  },
);

// ADMIN / WEB ROUTES

router.get("/all", validateDatabaseConnection, async (req, res) => {
  const t = Date.now();
  try {
    const users = await executeQuery(`
      SELECT u.id AS user_id, u.email, u.account_status, u.status, u.created_at, u.last_login, u.status_updated_at, u.home_address,
             p.type, p.bos, p.b_type, p.source_table,
             CASE WHEN p.source_table='resumption_table' THEN h2.FIRSTNAME WHEN p.source_table='beneficiaries_table' THEN h3.FIRSTNAME ELSE h1.FIRSTNAME END AS firstname,
             CASE WHEN p.source_table='resumption_table' THEN h2.LASTNAME  WHEN p.source_table='beneficiaries_table' THEN h3.LASTNAME  ELSE h1.LASTNAME  END AS lastname,
             CASE WHEN p.source_table='resumption_table' THEN h2.MIDDLENAME WHEN p.source_table='beneficiaries_table' THEN h3.MIDDLENAME ELSE h1.MIDDLENAME END AS middlename,
             CASE WHEN p.source_table='resumption_table' THEN h2.SUFFIX     WHEN p.source_table='beneficiaries_table' THEN h3.SUFFIX     ELSE h1.SUFFIX     END AS suffix,
             CASE WHEN p.source_table='resumption_table' THEN h2.DOB        WHEN p.source_table='beneficiaries_table' THEN h3.DOB        ELSE h1.DOB        END AS dob,
             CASE WHEN p.source_table='resumption_table' THEN h2.PRIN_DATE_RET WHEN p.source_table='beneficiaries_table' THEN h3.PRIN_DATE_RET ELSE h1.PRIN_DATE_RET END AS prin_date_ret,
             CASE WHEN p.source_table='resumption_table' THEN h2.CTRLNR    WHEN p.source_table='beneficiaries_table' THEN h3.CTRLNR    ELSE h1.CTRLNR    END AS ctrlnr,
             CASE WHEN p.source_table='resumption_table' THEN h2.PENRANK   WHEN p.source_table='beneficiaries_table' THEN h3.PENRANK   ELSE h1.PENRANK   END AS penrank,
             CASE WHEN p.source_table='resumption_table' THEN h2.ACRANK    WHEN p.source_table='beneficiaries_table' THEN h3.ACRANK    ELSE h1.ACRANK    END AS acrank,
             CASE WHEN p.source_table='resumption_table' THEN h2.MOBILENR  WHEN p.source_table='beneficiaries_table' THEN h3.MOBILENR  ELSE h1.MOBILENR  END AS mobile,
             CASE
               WHEN p.source_table='resumption_table' THEN
                 CASE WHEN h2.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS','O-W')
                   THEN CONCAT('O-',REPLACE(h2.AFPSN,'O-','')) ELSE h2.AFPSN END
               WHEN p.source_table='beneficiaries_table' THEN
                 CASE WHEN h3.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS','O-W')
                   THEN CONCAT('O-',REPLACE(h3.AFPSN,'O-','')) ELSE h3.AFPSN END
               ELSE
                 CASE WHEN h1.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS','O-W')
                   THEN CONCAT('O-',REPLACE(h1.AFPSN,'O-','')) ELSE h1.AFPSN END
             END AS afpsn
      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx=p.id
      LEFT JOIN heroes_tbl h1 ON p.hero_ndx=h1.NDX AND p.source_table='heroes_tbl'
      LEFT JOIN resumption_table h2 ON p.hero_ndx=h2.NDX AND p.source_table='resumption_table'
      LEFT JOIN beneficiaries_table h3 ON p.hero_ndx=h3.NDX AND p.source_table='beneficiaries_table'
      ORDER BY u.created_at DESC
    `);
    const stats = {
      totalUsers: users.length,
      principalUsers: users.filter((u) => u.type === "P").length,
      beneficiaryUsers: users.filter((u) => u.type === "B").length,
      activeUsers: users.filter((u) => u.status === "ACT" || u.status === "TAG")
        .length,
      testTableUsers: users.filter((u) => u.source_table === "heroes_tbl")
        .length,
      testResTableUsers: users.filter(
        (u) => u.source_table === "resumption_table",
      ).length,
      beneficiariesTableUsers: users.filter(
        (u) => u.source_table === "beneficiaries_table",
      ).length,
    };
    res.json({
      success: true,
      users,
      data: users,
      stats,
      count: users.length,
      meta: {
        processingTime: `${Date.now() - t}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("Fetch all users error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch users",
      code: "USERS_FETCH_ERROR",
    });
  }
});

router.get("/alpha-list", validateDatabaseConnection, async (req, res) => {
  const t = Date.now();
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(
      1,
      Math.min(1000, parseInt(req.query.limit, 10) || 100),
    );
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();
    const sourceFilter = req.query.source_table || "all";
    const likeParam = search ? `%${search.toUpperCase()}%` : null;

    const heroSearchCols = [
      "h.LASTNAME",
      "h.FIRSTNAME",
      "h.MIDDLENAME",
      "h.AFPSN",
      "h.CTRLNR",
      "h.PENRANK",
    ];
    const resSearchCols = [
      "r.LASTNAME",
      "r.FIRSTNAME",
      "r.MIDDLENAME",
      "r.AFPSN",
      "r.CTRLNR",
      "r.PENRANK",
    ];

    const buildWhere = (cols) =>
      likeParam
        ? "WHERE " + cols.map((c) => `UPPER(${c}) LIKE ?`).join(" OR ")
        : "";
    const heroesParams = likeParam ? heroSearchCols.map(() => likeParam) : [];
    const resParams = likeParam ? resSearchCols.map(() => likeParam) : [];

    const heroSelect = `
      SELECT 'heroes_tbl' AS source_table, h.NDX AS id, h.NDX AS user_id, h.NDX AS ndx,
             h.AFPSN AS afpsn, h.PENRANK AS penrank, h.ACRANK AS acrank,
             h.FIRSTNAME AS firstname, h.LASTNAME AS lastname, h.MIDDLENAME AS middlename, h.SUFFIX AS suffix,
             h.DOB AS dob, h.PRIN_DATE_RET AS prin_date_ret, h.CTRLNR AS ctrlnr, h.MOBILENR AS mobile,
             h.TYPE AS type, p.b_type, '' AS bos, 'ACT' AS status, NOW() AS status_updated_at,
             h.is_deceased, h.date_deceased,
             CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS has_account
      FROM heroes_tbl h
      LEFT JOIN pensioners_tbl p ON p.hero_ndx = h.NDX AND p.source_table = 'heroes_tbl'
      ${buildWhere(heroSearchCols)}`;

    const resSelect = `
      SELECT 'resumption_table' AS source_table, r.NDX AS id, r.NDX AS user_id, r.NDX AS ndx,
             CASE WHEN r.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS''O-W')
               THEN CONCAT('O-', REPLACE(r.AFPSN,'O-','')) ELSE r.AFPSN END AS afpsn,
             r.PENRANK AS penrank, r.ACRANK AS acrank,
             r.FIRSTNAME AS firstname, r.LASTNAME AS lastname, r.MIDDLENAME AS middlename, r.SUFFIX AS suffix,
             r.DOB AS dob, r.PRIN_DATE_RET AS prin_date_ret, r.CTRLNR AS ctrlnr, r.MOBILENR AS mobile,
             'P' AS type, NULL AS b_type, '' AS bos, 'AFR' AS status, NOW() AS status_updated_at,
             0 AS is_deceased, NULL AS date_deceased,
             CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS has_account
      FROM resumption_table r
      LEFT JOIN pensioners_tbl p ON p.hero_ndx = r.NDX AND p.source_table = 'resumption_table'
      ${buildWhere(resSearchCols)}`;

    let combinedSql, combinedParams;
    if (sourceFilter === "heroes_tbl") {
      combinedSql = heroSelect;
      combinedParams = heroesParams;
    } else if (sourceFilter === "resumption_table") {
      combinedSql = resSelect;
      combinedParams = resParams;
    } else {
      combinedSql = `(${heroSelect}) UNION ALL (${resSelect})`;
      combinedParams = [...heroesParams, ...resParams];
    }

    const pool = getPool();

    // Run count + data + per-table counts in parallel
    const [[countRows], [allUsers], [heroesCountRows], [resCountRows]] =
      await Promise.all([
        pool.execute(
          `SELECT COUNT(*) AS total FROM (${combinedSql}) AS combined`,
          combinedParams,
        ),
        pool.query(
          `SELECT * FROM (${combinedSql}) AS combined
   ORDER BY has_account DESC, lastname, firstname
   LIMIT ${limit} OFFSET ${offset}`,
          combinedParams,
        ),
        sourceFilter !== "resumption_table"
          ? pool.execute(
              "SELECT COUNT(*) AS cnt FROM heroes_tbl" +
                (likeParam
                  ? " WHERE UPPER(LASTNAME) LIKE ? OR UPPER(FIRSTNAME) LIKE ? OR UPPER(MIDDLENAME) LIKE ? OR UPPER(AFPSN) LIKE ? OR UPPER(CTRLNR) LIKE ? OR UPPER(PENRANK) LIKE ?"
                  : ""),
              likeParam ? Array(6).fill(likeParam) : [],
            )
          : Promise.resolve([[{ cnt: 0 }]]),
        sourceFilter !== "heroes_tbl"
          ? pool.execute(
              "SELECT COUNT(*) AS cnt FROM resumption_table" +
                (likeParam
                  ? " WHERE UPPER(LASTNAME) LIKE ? OR UPPER(FIRSTNAME) LIKE ? OR UPPER(MIDDLENAME) LIKE ? OR UPPER(AFPSN) LIKE ? OR UPPER(CTRLNR) LIKE ? OR UPPER(PENRANK) LIKE ?"
                  : ""),
              likeParam ? Array(6).fill(likeParam) : [],
            )
          : Promise.resolve([[{ cnt: 0 }]]),
      ]);

    const totalCount = countRows[0]?.total || 0;
    const heroesCount = heroesCountRows[0]?.cnt || 0;
    const resCount = resCountRows[0]?.cnt || 0;

    res.json({
      success: true,
      users: allUsers,
      data: allUsers,
      stats: { testTableUsers: heroesCount, testResTableUsers: resCount },
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasNext: offset + limit < totalCount,
        hasPrev: page > 1,
      },
      filters: { search, sourceTable: sourceFilter },
      count: allUsers.length,
      meta: {
        processingTime: `${Date.now() - t}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("Fetch alpha list error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch alpha list",
      code: "ALPHA_LIST_FETCH_ERROR",
    });
  }
});

router.post(
  "/add-to-alpha-list",
  validateDatabaseConnection,
  authenticateAdminToken,
  async (req, res) => {
    const t = Date.now();
    try {
      const {
        targetTable,
        lastname,
        firstname,
        middlename,
        suffix,
        dob,
        prin_date_ret,
        afpsn,
        acrank,
        penrank,
        type,
        ctrlnr,
        mobilenr,
      } = req.body;
      if (!lastname || !firstname || !afpsn)
        return res.status(400).json({
          success: false,
          error: "Last name, first name, and AFPSN are required",
          code: "VALIDATION_ERROR",
        });

      const tbl = safeTable(targetTable);

      if (ctrlnr) {
        const existing = await executeQuery(
          `SELECT NDX,LASTNAME,FIRSTNAME,MIDDLENAME,CTRLNR FROM ${tbl} WHERE CTRLNR=?`,
          [ctrlnr],
        );
        if (existing?.length > 0) {
          const e = existing[0];
          return res.status(409).json({
            success: false,
            error: "CTRLNR already exists in the database",
            code: "DUPLICATE_CTRLNR",
            existingRecord: {
              ndx: e.NDX,
              name: `${e.FIRSTNAME} ${e.MIDDLENAME || ""} ${e.LASTNAME}`.trim(),
              ctrlnr: e.CTRLNR,
            },
            targetTable: tbl,
          });
        }
      }

      const result = await executeQuery(
        `INSERT INTO ${tbl} (LASTNAME,FIRSTNAME,MIDDLENAME,SUFFIX,DOB,PRIN_DATE_RET,AFPSN,ACRANK,PENRANK,TYPE,CTRLNR,MOBILENR) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          lastname,
          firstname,
          middlename || null,
          suffix || null,
          dob || null,
          prin_date_ret || null,
          afpsn,
          acrank || null,
          penrank || null,
          type || "P",
          ctrlnr || null,
          mobilenr || null,
        ],
      );
      await insertAuditLog("ADD", req, {
        afpsn,
        firstname,
        lastname,
        sourceTable: tbl,
        recordNdx: result.insertId,
        newData: req.body,
      });
      res.json({
        success: true,
        message: `Record added successfully to ${tbl}`,
        insertId: result.insertId,
        targetTable: tbl,
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const isTableError = error.code === "INVALID_TABLE";
      res.status(isTableError ? 400 : 500).json({
        success: false,
        error: isTableError ? error.message : "Failed to add record to list",
        code: isTableError ? "INVALID_TABLE" : "ALPHA_LIST_ADD_ERROR",
      });
    }
  },
);

router.post(
  "/bulk-add-to-alpha-list",
  validateDatabaseConnection,
  authenticateAdminToken,
  upload.single("file"),
  async (req, res) => {
    const t = Date.now();
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded", code: "NO_FILE" });
      const tbl = safeTable(req.body.targetTable);

      const ext = req.file.originalname.split(".").pop().toLowerCase();
      let records;
      if (ext === "csv") records = parseCSV(req.file.buffer);
      else if (ext === "xlsx" || ext === "xls")
        records = await parseExcel(req.file.buffer);
      else
        return res.status(400).json({
          success: false,
          error: "Unsupported file format",
          code: "INVALID_FORMAT",
        });

      if (!records?.length)
        return res.status(400).json({
          success: false,
          error: "No valid records found in file",
          code: "EMPTY_FILE",
        });

      const results = {
        totalRecords: records.length,
        successCount: 0,
        errorCount: 0,
        errors: [],
        duplicates: [],
      };
      const existingCTRLNRs = await executeQuery(
        `SELECT CTRLNR FROM ${tbl} WHERE CTRLNR IS NOT NULL`,
      );
      const ctrlnrSet = new Set(
        existingCTRLNRs.map((r) => r.CTRLNR?.toString().toUpperCase()),
      );

      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const row = i + 2;
        try {
          const lastname = (record.lastname || record.LASTNAME)
            ?.toString()
            .trim()
            .toUpperCase();
          const firstname = (record.firstname || record.FIRSTNAME)
            ?.toString()
            .trim()
            .toUpperCase();
          const afpsn = (record.afpsn || record.AFPSN)
            ?.toString()
            .trim()
            .toUpperCase();
          if (!lastname || !firstname || !afpsn) {
            results.errorCount++;
            results.errors.push({
              row,
              afpsn: afpsn || "N/A",
              name: `${firstname || ""} ${lastname || ""}`.trim() || "N/A",
              error: "Missing required fields (LASTNAME, FIRSTNAME, AFPSN)",
            });
            continue;
          }

          const middlename =
            (record.middlename || record.MIDDLENAME)
              ?.toString()
              .trim()
              .toUpperCase() || null;
          const suffix =
            (record.suffix || record.SUFFIX)?.toString().trim().toUpperCase() ||
            null;
          const dob = formatDateForDB(
            record.dob || record.birthdate || record.BIRTHDATE,
          );
          const prin_date_ret = formatDateForDB(
            record.prin_date_ret || record.PRIN_DATE_RET,
          );
          const acrank =
            (record.acrank || record.ACRANK)?.toString().trim().toUpperCase() ||
            null;
          const penrank =
            (record.penrank || record.PENRANK)
              ?.toString()
              .trim()
              .toUpperCase() || null;
          const ctrlnr =
            (record.ctrlnr || record.ctrlno || record.CTRLNO)
              ?.toString()
              .trim()
              .toUpperCase() || null;
          const mobilenr =
            (record.mobilenr || record.mobileno || record.MOBILENR)
              ?.toString()
              .trim()
              .replace(/\D/g, "") || null;

          if (ctrlnr && ctrlnrSet.has(ctrlnr)) {
            results.duplicates.push({
              row,
              ctrlnr,
              name: `${firstname} ${lastname}`,
              reason: "Duplicate CTRLNR",
            });
            continue;
          }

          const typeRaw =
            (record.type || record["prin/bene"] || record["PRIN/BENE"])
              ?.toString()
              .trim()
              .toUpperCase() || "P";
          const type = typeRaw.includes("B") ? "B" : "P";

          const insertResult = await executeQuery(
            `INSERT INTO ${tbl} (LASTNAME,FIRSTNAME,MIDDLENAME,SUFFIX,DOB,PRIN_DATE_RET,AFPSN,ACRANK,PENRANK,TYPE,CTRLNR,MOBILENR) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              lastname,
              firstname,
              middlename,
              suffix,
              dob,
              prin_date_ret,
              afpsn,
              acrank,
              penrank,
              type,
              ctrlnr,
              mobilenr,
            ],
          );
          if (ctrlnr) ctrlnrSet.add(ctrlnr);
          results.successCount++;
          insertAuditLog("BULK_ADD", req, {
            afpsn,
            firstname,
            lastname,
            sourceTable: tbl,
            recordNdx: insertResult.insertId,
            newData: {
              lastname,
              firstname,
              middlename,
              suffix,
              dob,
              prin_date_ret,
              afpsn,
              acrank,
              penrank,
              type,
              ctrlnr,
              mobilenr,
            },
          }).catch((e) => logger.error("Audit log failed:", e.message));
        } catch (e) {
          results.errorCount++;
          results.errors.push({
            row,
            afpsn: record.afpsn || record.AFPSN || "N/A",
            name:
              `${record.firstname || record.FIRSTNAME || ""} ${record.lastname || record.LASTNAME || ""}`.trim() ||
              "N/A",
            error: e.message || "Database insertion failed",
          });
        }
      }
      res.json({
        success: true,
        message: "Bulk upload completed",
        data: results,
        targetTable: tbl,
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const isTableError = error.code === "INVALID_TABLE";
      res.status(isTableError ? 400 : 500).json({
        success: false,
        error: error.message || "Failed to process bulk upload",
        code: isTableError ? "INVALID_TABLE" : "BULK_UPLOAD_ERROR",
      });
    }
  },
);

router.put(
  "/update-alpha-list/:id",
  validateDatabaseConnection,
  authenticateAdminToken,
  async (req, res) => {
    const t = Date.now();
    try {
      const { id } = req.params;
      const {
        targetTable,
        lastname,
        firstname,
        middlename,
        suffix,
        dob,
        prin_date_ret,
        afpsn,
        acrank,
        penrank,
        type,
        b_type,
        ctrlnr,
        mobilenr,
        is_deceased,
        date_deceased,
      } = req.body;

      if (!id || !lastname || !firstname || !afpsn)
        return res.status(400).json({
          success: false,
          error: "ID, last name, first name, and AFPSN are required",
          code: "VALIDATION_ERROR",
        });
      const tbl = safeTable(targetTable); // [CRIT-1]

      const existing = await executeQuery(`SELECT * FROM ${tbl} WHERE NDX=?`, [
        id,
      ]);
      if (!existing?.length)
        return res.status(404).json({
          success: false,
          error: "Record not found",
          code: "RECORD_NOT_FOUND",
        });

      const isDeceasedValue = is_deceased ? 1 : 0;
      const dateDeceasedValue =
        is_deceased && date_deceased ? date_deceased : null;

      if (tbl === "heroes_tbl") {
        await executeQuery(
          `UPDATE ${tbl} SET LASTNAME=?,FIRSTNAME=?,MIDDLENAME=?,SUFFIX=?,DOB=?,PRIN_DATE_RET=?,AFPSN=?,ACRANK=?,PENRANK=?,TYPE=?,CTRLNR=?,MOBILENR=?,is_deceased=?,date_deceased=? WHERE NDX=?`,
          [
            lastname,
            firstname,
            middlename || null,
            suffix || null,
            dob || null,
            prin_date_ret || null,
            afpsn,
            acrank || null,
            penrank || null,
            type || "P",
            ctrlnr || null,
            mobilenr || null,
            isDeceasedValue,
            dateDeceasedValue,
            id,
          ],
        );
        if (isDeceasedValue === 1) {
          await executeQuery(
            "UPDATE users_tbl u INNER JOIN pensioners_tbl p ON u.pensioner_ndx=p.id SET u.status='DECEASED',u.updated_at=NOW() WHERE p.hero_ndx=? AND u.status!='DECEASED'",
            [id],
          );
        } else {
          await executeQuery(
            "UPDATE users_tbl u INNER JOIN pensioners_tbl p ON u.pensioner_ndx=p.id SET u.status='TAG',u.updated_at=NOW() WHERE p.hero_ndx=? AND u.status='DECEASED' AND (SELECT date_deceased FROM heroes_tbl WHERE NDX=?) IS NULL",
            [id, id],
          );
        }
      } else {
        await executeQuery(
          `UPDATE ${tbl} SET LASTNAME=?,FIRSTNAME=?,MIDDLENAME=?,SUFFIX=?,DOB=?,PRIN_DATE_RET=?,AFPSN=?,ACRANK=?,PENRANK=?,TYPE=?,CTRLNR=?,MOBILENR=? WHERE NDX=?`,
          [
            lastname,
            firstname,
            middlename || null,
            suffix || null,
            dob || null,
            prin_date_ret || null,
            afpsn,
            acrank || null,
            penrank || null,
            type || "P",
            ctrlnr || null,
            mobilenr || null,
            id,
          ],
        );
      }

      if (type === "B" && b_type) {
        await executeQuery(
          "UPDATE pensioners_tbl SET type=?,b_type=? WHERE hero_ndx=?",
          [type, b_type, id],
        );
      } else {
        await executeQuery(
          "UPDATE pensioners_tbl SET type=? WHERE hero_ndx=?",
          [type || "P", id],
        );
      }

      await insertAuditLog("UPDATE", req, {
        afpsn,
        firstname,
        lastname,
        sourceTable: tbl,
        recordNdx: parseInt(id),
        oldData: existing[0],
        newData: req.body,
      });
      res.json({
        success: true,
        message: `Record updated successfully in ${tbl}`,
        targetTable: tbl,
        meta: {
          processingTime: `${Date.now() - t}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const isTableError = error.code === "INVALID_TABLE";
      res.status(isTableError ? 400 : 500).json({
        success: false,
        error: isTableError ? error.message : "Failed to update record in list",
        code: isTableError ? "INVALID_TABLE" : "ALPHA_LIST_UPDATE_ERROR",
      });
    }
  },
);

// Multer error handler
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({
        success: false,
        error: "File size too large. Maximum size is 10MB",
        code: "FILE_TOO_LARGE",
      });
    return res
      .status(400)
      .json({ success: false, error: error.message, code: "UPLOAD_ERROR" });
  }
  next(error);
});

// ─── User PSA Orders ──────────────────────────────────────────────────────────

router.get("/my-orders", authenticateToken, async (req, res) => {
  const pool = getPool();
  const userId = req.user.userId; // from JWT

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const state = req.query.state?.trim() || "";
  const type = req.query.type?.trim() || "";

  try {
    // Resolve the hero_ndx for this user
    const [pensionerRows] = await pool.execute(
      `SELECT p.hero_ndx
       FROM users_tbl u
       JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
       WHERE u.id = ?
       LIMIT 1`,
      [userId],
    );

    if (pensionerRows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Pensioner record not found" });

    const { hero_ndx } = pensionerRows[0];

    // Build optional filters
    const conditions = [`po.owned_by_ndx = ?`];
    const params = [hero_ndx];

    if (state && state !== "all") {
      conditions.push(`po.state = ?`);
      params.push(state);
    }
    if (type && type !== "all") {
      conditions.push(`po.type = ?`);
      params.push(type);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.query(
      `SELECT SQL_CALC_FOUND_ROWS
          po.reference_number,
          po.state,
          po.type,
          po.afpsn,
          po.requester_name,
          po.requester_email,
          po.created_at,
          po.updated_at,
          po.purged_at,
          po.download_used,
          po.downloaded_at,
          JSON_UNQUOTE(JSON_EXTRACT(po.raw_json, '$.purge_on'))           AS purge_on,
          JSON_UNQUOTE(JSON_EXTRACT(po.raw_json, '$.organization_metadata.auth_code')) AS auth_code,
          JSON_UNQUOTE(JSON_EXTRACT(po.raw_json, '$.downloaded_at'))      AS psa_downloaded_at,
          pd.file_key IS NOT NULL AS has_document
        FROM psa_order_data po
        LEFT JOIN psa_documents pd ON pd.reference_number = po.reference_number
        ${where}
        ORDER BY po.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const [[{ total }]] = await pool.query(`SELECT FOUND_ROWS() AS total`);
    const totalPages = Math.ceil(Number(total) / limit);

    return res.json({
      success: true,
      data: rows,
      pagination: {
        total: Number(total),
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    console.error("My orders fetch error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch orders" });
  }
});

router.get(
  "/my-orders/:reference_number/document",
  authenticateToken,
  async (req, res) => {
    const pool = getPool();
    const { reference_number } = req.params;
    const userId = req.user.userId;

    console.log(`[download] start — user=${userId} ref=${reference_number}`);

    try {
      const [rows] = await pool.execute(
        `SELECT po.download_used, pd.file_key
       FROM psa_order_data po
       JOIN users_tbl u ON u.id = ?
       JOIN pensioners_tbl p ON p.id = u.pensioner_ndx
       LEFT JOIN psa_documents pd ON pd.reference_number = po.reference_number
       WHERE po.reference_number = ?
         AND po.owned_by_ndx = p.hero_ndx
       LIMIT 1`,
        [userId, reference_number],
      );

      console.log(
        `[download] ownership query — rows=${rows.length}`,
        rows[0] ?? "none",
      );

      if (rows.length === 0)
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });

      if (rows[0].download_used)
        return res.status(403).json({
          success: false,
          code: "DOWNLOAD_EXHAUSTED",
          message: "This document has already been downloaded.",
        });

      const [updateResult] = await pool.execute(
        `UPDATE psa_order_data
       SET download_used = 1, downloaded_at = NOW()
       WHERE reference_number = ? AND download_used = 0`,
        [reference_number],
      );

      console.log(
        `[download] UPDATE affectedRows=${updateResult.affectedRows}`,
      );

      if (updateResult.affectedRows === 0)
        return res.status(403).json({
          success: false,
          code: "DOWNLOAD_EXHAUSTED",
          message: "This document has already been downloaded.",
        });

      const { file_key } = rows[0];
      console.log(
        `[download] file_key=${file_key ?? "null — will try PSA API"}`,
      );

      // Change serveDocument to return the signed URL rather than pipe it
      const serveDocument = async () => {
        if (file_key) {
          const { Readable } = require("stream");
          const { GetObjectCommand } = require("@aws-sdk/client-s3");
          const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
          const { getPsaPgmcBucketClient } = require("../services/psaS3");

          const signedUrl = await getSignedUrl(
            getPsaPgmcBucketClient(),
            new GetObjectCommand({
              Bucket: process.env.SPACES_BUCKET,
              Key: file_key,
            }),
            { expiresIn: 60 }, // only needs to last long enough for your server to fetch it
          );

          const pdfResponse = await fetch(signedUrl);
          if (!pdfResponse.ok)
            throw new Error(`Spaces fetch failed: ${pdfResponse.status}`);

          res.setHeader("Content-Type", "application/pdf");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${reference_number}.pdf"`, // <-- attachment forces download
          );
          res.setHeader("Cache-Control", "no-store"); // don't cache — one-time document

          Readable.fromWeb(pdfResponse.body).pipe(res);
          return;
        }

        // PSA API fallback — fetch and proxy the same way
        const psaRes = await fetch(
          `${process.env.PSA_API_BASE_URL}/orders/${reference_number}/download`,
          {
            headers: {
              Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
              Accept: "application/json",
            },
          },
        );
        if (!psaRes.ok) throw new Error(`PSA API error: ${psaRes.status}`);

        const { url } = await psaRes.json();
        if (!url) throw new Error("No download URL returned");

        const { Readable } = require("stream");
        const fileRes = await fetch(url);
        if (!fileRes.ok)
          throw new Error(`PSA file fetch failed: ${fileRes.status}`);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${reference_number}.pdf"`,
        );
        res.setHeader("Cache-Control", "no-store");
        Readable.fromWeb(fileRes.body).pipe(res);
      };

      try {
        await serveDocument();
        console.log(`[download] done — response sent`);
      } catch (serveErr) {
        console.error(
          `[download] serveDocument failed, rolling back slot`,
          serveErr,
        );
        await pool.execute(
          `UPDATE psa_order_data SET download_used = 0, downloaded_at = NULL WHERE reference_number = ?`,
          [reference_number],
        );
        throw serveErr;
      }
    } catch (err) {
      console.error("Document download error:", err);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ success: false, message: "Failed to fetch document" });
      }
    }
  },
);

module.exports = { router, shutdown };
