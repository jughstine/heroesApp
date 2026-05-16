const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../config/database");
const {
  sendStatusChangeNotification,
} = require("../services/pushNotificationService");
const multer = require("multer");
const { Client } = require("minio");

const IS_PROD = process.env.NODE_ENV === "production";

// ─── Multer ────────────────────────────────────────────────────────────────────

const profileUpload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ]);
    allowed.has(file.mimetype)
      ? cb(null, true)
      : cb(
          new Error(
            `Invalid file type: ${file.mimetype}. Only JPEG, PNG, and WebP allowed.`,
          ),
          false,
        );
  },
});

// ─── MinIO ─────────────────────────────────────────────────────────────────────

const minioClient = new Client({
  endPoint: process.env.SPACES_ENDPOINT.replace("https://", ""),
  port: 443,
  useSSL: true,
  accessKey: process.env.SPACES_KEY,
  secretKey: process.env.SPACES_SECRET,
});

// ─── DB helpers ────────────────────────────────────────────────────────────────

const getPool = () => db.getPool();

/**
 * Runs a callback inside a pool transaction.
 * Automatically commits on success and rolls back on error.
 *
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
const withTransaction = async (fn) => {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

// allowlisted table names resolved via a Map — never interpolated from
// user input directly, even after allowlist checks.
const SOURCE_TABLE_MAP = {
  heroes_tbl: "heroes_tbl",
  resumption_table: "resumption_table",
  beneficiaries_table: "beneficiaries_table",
};

const TRANSFER_SOURCE_TABLES = new Set([
  "resumption_table",
  "beneficiaries_table",
]);
const ALL_SOURCE_TABLES = new Set(Object.keys(SOURCE_TABLE_MAP));

// ─── Profile picture helpers ──────────────────────────────────────────────────

const buildProfilePictureUrl = (fileName) =>
  `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_REGION || "sgp1"}.digitaloceanspaces.com/${fileName}`;

const uploadProfilePicture = async (file) => {
  const fileName = `admin-profiles/${Date.now()}-${file.originalname}`;
  await minioClient.putObject(
    process.env.SPACES_BUCKET,
    fileName,
    file.buffer,
    file.size,
    {
      "Content-Type": file.mimetype,
      "x-amz-acl": "public-read",
    },
  );
  return buildProfilePictureUrl(fileName);
};

const deleteProfilePicture = async (url) => {
  try {
    const key = url.split(".digitaloceanspaces.com/")[1];
    if (key) await minioClient.removeObject(process.env.SPACES_BUCKET, key);
  } catch (err) {
    console.error("Error deleting old profile picture:", err);
    // Non-fatal — continue even if deletion fails
  }
};

// ─── Auth middleware ───────────────────────────────────────────────────────────

const authenticateAdminToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .json({ success: false, error: "Access token required" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res
        .status(403)
        .json({ success: false, error: "Invalid or expired token" });
    }
    if (decoded.type !== "admin") {
      return res
        .status(403)
        .json({ success: false, error: "Admin access required" });
    }
    req.admin = decoded;
    next();
  });
};

const requireSuperAdmin = (req, res, next) => {
  if (req.admin.role !== "S_ADMIN") {
    return res
      .status(403)
      .json({ success: false, error: "Super admin access required" });
  }
  next();
};

// ─── Timezone helper ───────────────────────────────────────────────────────────

const toPHTime = (dateInput) => {
  if (!dateInput) return null;
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const ph = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${ph.getUTCFullYear()}-${pad(ph.getUTCMonth() + 1)}-${pad(ph.getUTCDate())}` +
    `T${pad(ph.getUTCHours())}:${pad(ph.getUTCMinutes())}:${pad(ph.getUTCSeconds())}+08:00`
  );
};

// ─── Internal 500 helper ───────────────────────────────────────────────────────

const internalError = (res, error, fallback = "Internal server error") => {
  console.error(error);
  res.status(500).json({
    success: false,
    error: IS_PROD ? fallback : error.message,
  });
};

// ─── Routes ────────────────────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "Email and password are required" });
    }

    const [rows] = await getPool().execute(
      `SELECT id, email, password_hash, name, mobile_number, role, profile_picture, created_at
       FROM admins_tbl WHERE email = ? LIMIT 1`,
      [email.trim().toLowerCase()],
    );

    const admin = rows[0];
    const dummyHash =
      "$2a$12$invalidhashfortimingprotection000000000000000000000000";
    const isValid = await bcrypt.compare(
      password,
      admin?.password_hash ?? dummyHash,
    );

    if (!admin || !isValid) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid email or password" });
    }

    const currentPHTime = toPHTime(new Date());

    // Fire-and-forget last_login_at update
    getPool()
      .execute(
        `UPDATE admins_tbl SET last_login_at = CONVERT_TZ(NOW(), @@session.time_zone, '+08:00') WHERE id = ?`,
        [admin.id],
      )
      .catch((err) => console.error("Failed to update last_login_at:", err));

    const token = jwt.sign(
      {
        adminId: admin.id,
        id: admin.id,
        email: admin.email,
        name: admin.name,
        mobileNumber: admin.mobile_number,
        role: admin.role,
        loginAt: currentPHTime,
        type: "admin",
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRATION || "24h",
        issuer: "afppgmc-admin-web",
        audience: "afppgmc-admin-panel",
      },
    );

    return res.json({
      success: true,
      message: "Login successful",
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        mobileNumber: admin.mobile_number,
        role: admin.role,
        profile_picture: admin.profile_picture,
        createdAt: toPHTime(admin.created_at),
        lastLoginAt: currentPHTime,
      },
      token,
    });
  } catch (error) {
    internalError(res, error, "Login failed");
  }
});

router.get("/profile", authenticateAdminToken, (req, res) => {
  const { adminId, email, name, mobileNumber, role, loginAt } = req.admin;
  res.json({
    success: true,
    admin: { id: adminId, email, name, mobileNumber, role, loginAt },
  });
});

router.get("/verify", authenticateAdminToken, (req, res) => {
  const { adminId, id, email, name, mobileNumber, role, loginAt } = req.admin;
  res.json({
    success: true,
    valid: true,
    admin: { id: adminId || id, email, name, mobileNumber, role, loginAt },
  });
});

router.post("/logout", authenticateAdminToken, (_req, res) => {
  res.json({ success: true, message: "Logged out successfully" });
});

// ─── Admin management ──────────────────────────────────────────────────────────

router.get(
  "/admins",
  authenticateAdminToken,
  requireSuperAdmin,
  async (_req, res) => {
    try {
      const [admins] = await getPool().execute(
        `SELECT id, email, name, mobile_number, role, created_at, last_login_at, profile_picture
       FROM admins_tbl ORDER BY created_at DESC`,
      );
      res.json({ success: true, data: admins, total: admins.length });
    } catch (error) {
      internalError(res, error, "Failed to fetch admins");
    }
  },
);

router.get(
  "/admin/:id",
  authenticateAdminToken,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const pool = getPool();

      const [[rows], [navPerms], [formPerms]] = await Promise.all([
        pool.execute(
          `SELECT id, email, name, mobile_number, role, profile_picture, created_at, last_login_at
         FROM admins_tbl WHERE id = ?`,
          [id],
        ),
        pool.execute(
          `SELECT nav_permission_id FROM admin_nav_access WHERE admin_id = ?`,
          [id],
        ),
        pool.execute(
          `SELECT form_type_id, can_view, can_create, can_edit, can_delete
         FROM admin_form_access WHERE admin_id = ?`,
          [id],
        ),
      ]);

      if (rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Admin not found" });
      }

      res.json({
        success: true,
        data: {
          ...rows[0],
          navPermissions: navPerms.map((p) => p.nav_permission_id),
          formPermissions: formPerms,
        },
      });
    } catch (error) {
      internalError(res, error, "Failed to fetch admin details");
    }
  },
);

router.post(
  "/create-admin",
  authenticateAdminToken,
  requireSuperAdmin,
  profileUpload.single("profilePicture"),
  async (req, res) => {
    try {
      const {
        email,
        password,
        name,
        mobileNumber,
        role,
        navPermissions,
        formPermissions,
      } = req.body;

      if (!email || !password || !name) {
        return res.status(400).json({
          success: false,
          error: "Email, password, and name are required",
        });
      }

      let parsedNavPerms = [],
        parsedFormPerms = [];
      try {
        if (navPermissions)
          parsedNavPerms =
            typeof navPermissions === "string"
              ? JSON.parse(navPermissions)
              : navPermissions;
        if (formPermissions)
          parsedFormPerms =
            typeof formPermissions === "string"
              ? JSON.parse(formPermissions)
              : formPermissions;
      } catch {
        return res
          .status(400)
          .json({ success: false, error: "Invalid permissions format" });
      }

      if (
        !parsedNavPerms.every(Number.isInteger) ||
        !parsedFormPerms.every((fp) => Number.isInteger(fp.formTypeId))
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Permission IDs must be integers" });
      }

      let profilePictureUrl = null;
      if (req.file) profilePictureUrl = await uploadProfilePicture(req.file);

      const hashedPassword = await bcrypt.hash(password, 12);

      const newAdminId = await withTransaction(async (conn) => {
        const [existing] = await conn.execute(
          "SELECT id FROM admins_tbl WHERE email = ?",
          [email.trim().toLowerCase()],
        );
        if (existing.length > 0) {
          const err = new Error("Admin with this email already exists");
          err.status = 409;
          throw err;
        }

        const [result] = await conn.execute(
          `INSERT INTO admins_tbl (email, password_hash, name, mobile_number, role, profile_picture, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [
            email.trim().toLowerCase(),
            hashedPassword,
            name.trim(),
            mobileNumber || null,
            role || "ADMIN",
            profilePictureUrl,
          ],
        );

        const newId = result.insertId;

        if (parsedNavPerms.length > 0) {
          const placeholders = parsedNavPerms.map(() => "(?, ?)").join(",");
          const values = parsedNavPerms.flatMap((navId) => [newId, navId]);
          await conn.execute(
            `INSERT INTO admin_nav_access (admin_id, nav_permission_id) VALUES ${placeholders}`,
            values,
          );
        }

        if (parsedFormPerms.length > 0) {
          const placeholders = parsedFormPerms
            .map(() => "(?, ?, ?, ?, ?, ?)")
            .join(",");
          const values = parsedFormPerms.flatMap((fp) => [
            newId,
            fp.formTypeId,
            fp.canView ? 1 : 0,
            fp.canCreate ? 1 : 0,
            fp.canEdit ? 1 : 0,
            fp.canDelete ? 1 : 0,
          ]);
          await conn.execute(
            `INSERT INTO admin_form_access (admin_id, form_type_id, can_view, can_create, can_edit, can_delete)
             VALUES ${placeholders}`,
            values,
          );
        }

        return newId;
      });

      res.status(201).json({
        success: true,
        message: "Admin account created successfully",
        data: {
          id: newAdminId,
          email: email.trim().toLowerCase(),
          name: name.trim(),
          mobileNumber: mobileNumber || null,
          role: role || "ADMIN",
          profilePictureUrl,
        },
      });
    } catch (error) {
      if (error.status === 409 || error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          success: false,
          error: "Admin with this email already exists",
        });
      }
      internalError(res, error, "Failed to create admin account");
    }
  },
);

router.put(
  "/admin/:id/settings",
  authenticateAdminToken,
  requireSuperAdmin,
  profileUpload.single("profilePicture"),
  async (req, res) => {
    try {
      const adminId = req.params.id;
      const { email, password, currentPassword, role, name } = req.body;

      const updates = [];
      const values = [];

      if (name) {
        updates.push("name = ?");
        values.push(name.trim());
      }
      if (email) {
        updates.push("email = ?");
        values.push(email.trim().toLowerCase());
      }
      if (role) {
        updates.push("role = ?");
        values.push(role);
      }

      if (password) {
        if (!currentPassword) {
          return res.status(400).json({
            success: false,
            error: "Current password required to set a new password",
          });
        }

        const [[row]] = await getPool().execute(
          "SELECT password_hash FROM admins_tbl WHERE id = ?",
          [adminId],
        );
        if (!row)
          return res
            .status(404)
            .json({ success: false, error: "Admin not found" });

        const isValid = await bcrypt.compare(
          currentPassword,
          row.password_hash,
        );
        if (!isValid)
          return res
            .status(401)
            .json({ success: false, error: "Current password is incorrect" });

        updates.push("password_hash = ?");
        values.push(await bcrypt.hash(password, 12));
      }

      let profilePictureUrl = null;
      if (req.file) {
        const [[existing]] = await getPool().execute(
          "SELECT profile_picture FROM admins_tbl WHERE id = ?",
          [adminId],
        );
        if (existing?.profile_picture)
          await deleteProfilePicture(existing.profile_picture);

        profilePictureUrl = await uploadProfilePicture(req.file);
        updates.push("profile_picture = ?");
        values.push(profilePictureUrl);
      }

      if (updates.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: "No fields to update" });
      }

      values.push(adminId);
      await getPool().execute(
        `UPDATE admins_tbl SET ${updates.join(", ")} WHERE id = ?`,
        values,
      );

      res.json({
        success: true,
        message: "Admin settings updated successfully",
        data: { profilePictureUrl: profilePictureUrl || undefined },
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        return res
          .status(409)
          .json({ success: false, error: "Email already in use" });
      }
      internalError(res, error, "Failed to update admin settings");
    }
  },
);

router.put(
  "/admin/:id/permissions",
  authenticateAdminToken,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const adminId = req.params.id;
      const { navPermissions = [], formPermissions = [] } = req.body;

      if (
        !navPermissions.every(Number.isInteger) ||
        !formPermissions.every((fp) => Number.isInteger(fp.formTypeId))
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Permission IDs must be integers" });
      }

      await withTransaction(async (conn) => {
        await Promise.all([
          conn.execute("DELETE FROM admin_nav_access  WHERE admin_id = ?", [
            adminId,
          ]),
          conn.execute("DELETE FROM admin_form_access WHERE admin_id = ?", [
            adminId,
          ]),
        ]);

        if (navPermissions.length > 0) {
          const ph = navPermissions.map(() => "(?, ?)").join(",");
          const val = navPermissions.flatMap((navId) => [adminId, navId]);
          await conn.execute(
            `INSERT INTO admin_nav_access (admin_id, nav_permission_id) VALUES ${ph}`,
            val,
          );
        }

        if (formPermissions.length > 0) {
          const ph = formPermissions.map(() => "(?, ?, ?, ?, ?, ?)").join(",");
          const val = formPermissions.flatMap((fp) => [
            adminId,
            fp.formTypeId,
            fp.canView ? 1 : 0,
            fp.canCreate ? 1 : 0,
            fp.canEdit ? 1 : 0,
            fp.canDelete ? 1 : 0,
          ]);
          await conn.execute(
            `INSERT INTO admin_form_access (admin_id, form_type_id, can_view, can_create, can_edit, can_delete) VALUES ${ph}`,
            val,
          );
        }
      });

      res.json({ success: true, message: "Permissions updated successfully" });
    } catch (error) {
      internalError(res, error, "Failed to update permissions");
    }
  },
);

router.delete(
  "/admin/:id",
  authenticateAdminToken,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const adminId = parseInt(req.params.id, 10);
      if (req.admin.id === adminId || req.admin.adminId === adminId) {
        return res
          .status(400)
          .json({ success: false, error: "Cannot delete your own account" });
      }

      await withTransaction(async (conn) => {
        await Promise.all([
          conn.execute("DELETE FROM admin_nav_access  WHERE admin_id = ?", [
            adminId,
          ]),
          conn.execute("DELETE FROM admin_form_access WHERE admin_id = ?", [
            adminId,
          ]),
        ]);
        await conn.execute("DELETE FROM admins_tbl WHERE id = ?", [adminId]);
      });

      res.json({ success: true, message: "Admin deleted successfully" });
    } catch (error) {
      internalError(res, error, "Failed to delete admin");
    }
  },
);

// ─── Permissions ───────────────────────────────────────────────────────────────

router.get("/nav-permissions", authenticateAdminToken, async (_req, res) => {
  try {
    const [rows] = await getPool().execute(
      "SELECT id, name, path, description FROM nav_permissions ORDER BY name",
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    internalError(res, error, "Failed to fetch navigation permissions");
  }
});

router.get("/form-types", authenticateAdminToken, async (_req, res) => {
  try {
    const [rows] = await getPool().execute(
      "SELECT id, name FROM form_type ORDER BY name",
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    internalError(res, error, "Failed to fetch form types");
  }
});

router.get("/my-permissions", authenticateAdminToken, async (req, res) => {
  try {
    const adminId = req.admin.id || req.admin.adminId;
    const pool = getPool();

    if (req.admin.role === "S_ADMIN") {
      const [[navPerms], [formTypes]] = await Promise.all([
        pool.execute("SELECT id, name, path, description FROM nav_permissions"),
        pool.execute("SELECT id, name FROM form_type"),
      ]);
      return res.json({
        success: true,
        data: {
          navPermissions: navPerms,
          formPermissions: formTypes.map((ft) => ({
            formTypeId: ft.id,
            formTypeName: ft.name,
            canView: true,
            canCreate: true,
            canEdit: true,
            canDelete: true,
          })),
        },
      });
    }

    const [[navPerms], [formPerms]] = await Promise.all([
      pool.execute(
        `SELECT np.id, np.name, np.path, np.description
         FROM nav_permissions np
         INNER JOIN admin_nav_access ana ON np.id = ana.nav_permission_id
         WHERE ana.admin_id = ?`,
        [adminId],
      ),
      pool.execute(
        `SELECT afa.form_type_id as formTypeId, ft.name as formTypeName,
                afa.can_view as canView, afa.can_create as canCreate,
                afa.can_edit as canEdit,  afa.can_delete as canDelete
         FROM admin_form_access afa
         INNER JOIN form_type ft ON afa.form_type_id = ft.id
         WHERE afa.admin_id = ?`,
        [adminId],
      ),
    ]);

    res.json({
      success: true,
      data: { navPermissions: navPerms, formPermissions: formPerms },
    });
  } catch (error) {
    internalError(res, error, "Failed to fetch permissions");
  }
});

// ─── Stats ─────────────────────────────────────────────────────────────────────

router.get(
  "/stats",
  authenticateAdminToken,
  requireSuperAdmin,
  async (_req, res) => {
    try {
      const [[row]] = await getPool().execute(`
      SELECT
        COUNT(*)                                        AS totalAdmins,
        SUM(last_login_at IS NOT NULL)                  AS activeAdmins,
        SUM(role = 'S_ADMIN')                           AS superAdmins,
        SUM(role = 'ADMIN')                             AS regularAdmins
      FROM admins_tbl
    `);
      res.json({
        success: true,
        stats: { ...row, lastUpdated: new Date().toISOString() },
      });
    } catch (error) {
      internalError(res, error, "Failed to fetch statistics");
    }
  },
);

// ─── Same-role admins ──────────────────────────────────────────────────────────

router.get("/admins/same-role", authenticateAdminToken, async (req, res) => {
  try {
    const { role, adminId, id } = req.admin;
    const currentId = adminId || id;

    if (!role) {
      return res.status(400).json({
        success: false,
        error: "User role not found",
        code: "MISSING_ROLE",
      });
    }

    const isSuperOrCares = role === "S_ADMIN" || role === "CARES";
    const [results] = await getPool().execute(
      isSuperOrCares
        ? `SELECT id, email, name, mobile_number as mobileNumber, role, created_at as createdAt
           FROM admins_tbl WHERE id != ? ORDER BY role ASC, name ASC`
        : `SELECT id, email, name, mobile_number as mobileNumber, role, created_at as createdAt
           FROM admins_tbl WHERE (role = ? OR role = 'CARES') AND id != ? ORDER BY role ASC, name ASC`,
      isSuperOrCares ? [currentId] : [role, currentId],
    );

    res.json({
      success: true,
      data: results,
      meta: {
        count: results.length,
        current_user_role: role,
        current_user_id: currentId,
        is_super_admin: role === "S_ADMIN",
        can_assign_to_all: isSuperOrCares,
      },
    });
  } catch (error) {
    internalError(res, error, "Failed to fetch admins");
  }
});

// ─── User status ───────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set([
  "ACT",
  "TAG",
  "DEL",
  "FOR_PAYROLL",
  "AFR",
  "AFB",
  "AFB2",
  "UNV",
]);

router.put(
  "/users/:userId/status",
  authenticateAdminToken,
  async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;

    if (!status || !VALID_STATUSES.has(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }

    const conn = await getPool().getConnection();
    try {
      const [[user]] = await conn.execute(
        "SELECT id, status, push_token, FIRSTNAME, LASTNAME FROM users_tbl WHERE id = ?",
        [userId],
      );
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

      const oldStatus = user.status;
      if (oldStatus === status) {
        return res.json({
          success: true,
          message: "Status unchanged",
          data: { userId: parseInt(userId), status, changed: false },
        });
      }

      await conn.execute(
        "UPDATE users_tbl SET status = ?, updated_at = NOW() WHERE id = ?",
        [status, userId],
      );

      if (status === "DECEASED") {
        await conn.execute(
          `UPDATE heroes_tbl h
         INNER JOIN pensioners_tbl p ON p.hero_ndx = h.NDX
         INNER JOIN users_tbl u ON u.pensioner_ndx = p.id
         SET h.is_deceased = 1
         WHERE u.id = ? AND h.is_deceased = 0`,
          [userId],
        );
      } else if (oldStatus === "DECEASED") {
        await conn.execute(
          `UPDATE heroes_tbl h
         INNER JOIN pensioners_tbl p ON p.hero_ndx = h.NDX
         INNER JOIN users_tbl u ON u.pensioner_ndx = p.id
         SET h.is_deceased = 0, h.date_deceased = NULL
         WHERE u.id = ? AND h.date_deceased IS NULL`,
          [userId],
        );
      }

      let notificationResult = { sent: false, reason: null, error: null };
      if (user.push_token) {
        try {
          const result = await sendStatusChangeNotification(
            conn,
            user.id,
            oldStatus,
            status,
            user.FIRSTNAME,
            user.LASTNAME,
          );
          if (result.success) {
            notificationResult.sent = true;
          } else {
            notificationResult.error = result.error;
            if (result.shouldRemoveToken) {
              await conn.execute(
                "UPDATE users_tbl SET push_token = NULL WHERE id = ?",
                [userId],
              );
              notificationResult.reason = "Invalid token removed";
            }
          }
        } catch (err) {
          notificationResult.error = err.message;
        }
      } else {
        notificationResult.reason = "No push token";
      }

      res.json({
        success: true,
        message: "User status updated successfully",
        data: {
          userId: parseInt(userId),
          userName: `${user.FIRSTNAME} ${user.LASTNAME}`,
          oldStatus,
          newStatus: status,
          changed: true,
          updatedAt: new Date().toISOString(),
          notification: notificationResult,
        },
      });
    } catch (error) {
      internalError(res, error, "Failed to update user status");
    } finally {
      conn.release();
    }
  },
);

// ─── Transfer to Alpha ─────────────────────────────────────────────────────────

// Shared column list for both source tables
const HERO_COLUMNS =
  "LASTNAME,FIRSTNAME,MIDDLENAME,SUFFIX,DOB,AFPSN,ACRANK,PENRANK,TYPE,CTRLNR,MOBILENR";
const HERO_PARAMS = HERO_COLUMNS.split(",")
  .map((c) => `h.${c}`)
  .join(",");

router.post(
  "/users/:userId/transfer-to-alpha",
  authenticateAdminToken,
  async (req, res) => {
    const startTime = Date.now();
    try {
      const { userId } = req.params;

      const [[pensioner]] = await getPool().execute(
        `SELECT p.id as pensioner_id, p.hero_ndx, p.source_table, p.type, p.principal_ndx
       FROM users_tbl u
       JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
       WHERE u.id = ? LIMIT 1`,
        [userId],
      );

      if (!pensioner) {
        return res.status(404).json({
          success: false,
          error: "Pensioner record not found",
          code: "PENSIONER_NOT_FOUND",
        });
      }
      if (pensioner.source_table === "heroes_tbl") {
        return res.status(400).json({
          success: false,
          error: "User is already in Alpha List",
          code: "ALREADY_IN_ALPHA",
        });
      }
      if (!TRANSFER_SOURCE_TABLES.has(pensioner.source_table)) {
        return res.status(400).json({
          success: false,
          error: "User is not in Resumption or Beneficiaries list",
          code: "INVALID_SOURCE_TABLE",
        });
      }

      const safeTable = SOURCE_TABLE_MAP[pensioner.source_table];
      const [[hero]] = await getPool().execute(
        `SELECT ${HERO_COLUMNS} FROM ${safeTable} WHERE NDX = ? LIMIT 1`,
        [pensioner.hero_ndx],
      );
      if (!hero) {
        return res.status(404).json({
          success: false,
          error: `Hero data not found in ${safeTable}`,
          code: "HERO_DATA_NOT_FOUND",
        });
      }

      const newHeroNdx = await withTransaction(async (conn) => {
        const [insertResult] = await conn.execute(
          `INSERT INTO heroes_tbl (${HERO_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          HERO_COLUMNS.split(",").map((c) => hero[c]),
        );
        const newId = insertResult.insertId;
        const newPrincipalNdx =
          pensioner.type === "P" ? newId : (pensioner.principal_ndx ?? newId);

        await Promise.all([
          conn.execute(
            `UPDATE pensioners_tbl SET hero_ndx = ?, source_table = 'heroes_tbl', principal_ndx = ? WHERE id = ?`,
            [newId, newPrincipalNdx, pensioner.pensioner_id],
          ),
          conn.execute(
            `UPDATE users_tbl SET status = 'ACT', status_updated_at = NOW() WHERE id = ?`,
            [userId],
          ),
          conn.execute(`DELETE FROM ${safeTable} WHERE NDX = ?`, [
            pensioner.hero_ndx,
          ]),
        ]);

        return newId;
      });

      res.json({
        success: true,
        message: "User successfully transferred to Alpha List",
        data: {
          userId: parseInt(userId),
          pensionerId: pensioner.pensioner_id,
          oldHeroNdx: pensioner.hero_ndx,
          newHeroNdx,
          oldSourceTable: pensioner.source_table,
          newSourceTable: "heroes_tbl",
          status: "ACT",
        },
        meta: {
          processingTime: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      internalError(res, error, "Failed to transfer user to Alpha List");
    }
  },
);

router.post(
  "/pensioners/:heroNdx/transfer-to-alpha",
  authenticateAdminToken,
  async (req, res) => {
    const startTime = Date.now();
    try {
      const { heroNdx } = req.params;
      const { sourceTable } = req.body;

      if (!sourceTable || !TRANSFER_SOURCE_TABLES.has(sourceTable)) {
        return res.status(400).json({
          success: false,
          error: "Invalid source table",
          code: "INVALID_SOURCE_TABLE",
        });
      }

      const safeTable = SOURCE_TABLE_MAP[sourceTable];
      const [[hero]] = await getPool().execute(
        `SELECT ${HERO_COLUMNS}, PRIN_DATE_RET FROM ${safeTable} WHERE NDX = ? LIMIT 1`,
        [heroNdx],
      );
      if (!hero) {
        return res.status(404).json({
          success: false,
          error: `Hero not found in ${safeTable}`,
          code: "HERO_DATA_NOT_FOUND",
        });
      }

      const [[existing]] = await getPool().execute(
        "SELECT NDX FROM heroes_tbl WHERE AFPSN = ? LIMIT 1",
        [hero.AFPSN],
      );
      if (existing) {
        return res.status(400).json({
          success: false,
          error: "AFPSN already exists in Alpha List",
          code: "ALREADY_IN_ALPHA",
          existingNdx: existing.NDX,
        });
      }

      const newHeroNdx = await withTransaction(async (conn) => {
        const [result] = await conn.execute(
          `INSERT INTO heroes_tbl (${HERO_COLUMNS}, PRIN_DATE_RET) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [...HERO_COLUMNS.split(",").map((c) => hero[c]), hero.PRIN_DATE_RET],
        );
        await conn.execute(`DELETE FROM ${safeTable} WHERE NDX = ?`, [heroNdx]);
        return result.insertId;
      });

      res.json({
        success: true,
        message: "Record successfully transferred to Alpha List",
        data: {
          oldHeroNdx: parseInt(heroNdx),
          newHeroNdx,
          oldSourceTable: sourceTable,
          newSourceTable: "heroes_tbl",
          afpsn: hero.AFPSN,
          name: `${hero.FIRSTNAME} ${hero.LASTNAME}`,
        },
        meta: {
          processingTime: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      internalError(res, error, "Failed to transfer record to Alpha List");
    }
  },
);

// ─── Delete pensioner ──────────────────────────────────────────────────────────

router.delete(
  "/pensioners/:heroNdx",
  authenticateAdminToken,
  async (req, res) => {
    const startTime = Date.now();
    try {
      const { heroNdx } = req.params;
      const { sourceTable } = req.query;

      if (!sourceTable || !ALL_SOURCE_TABLES.has(sourceTable)) {
        return res.status(400).json({
          success: false,
          error: "Invalid or missing source table",
          code: "INVALID_SOURCE_TABLE",
        });
      }

      const safeTable = SOURCE_TABLE_MAP[sourceTable];
      const [[record]] = await getPool().execute(
        `SELECT NDX, LASTNAME, FIRSTNAME, AFPSN FROM ${safeTable} WHERE NDX = ? LIMIT 1`,
        [heroNdx],
      );
      if (!record) {
        return res.status(404).json({
          success: false,
          error: `Record not found in ${safeTable}`,
          code: "RECORD_NOT_FOUND",
        });
      }

      await getPool().execute(`DELETE FROM ${safeTable} WHERE NDX = ?`, [
        heroNdx,
      ]);

      res.json({
        success: true,
        message: "Record successfully deleted",
        data: {
          deletedNdx: parseInt(heroNdx),
          sourceTable,
          afpsn: record.AFPSN,
          name: `${record.FIRSTNAME} ${record.LASTNAME}`,
        },
        meta: {
          processingTime: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      internalError(res, error, "Failed to delete record");
    }
  },
);

// ─── Delete user ───────────────────────────────────────────────────────────────

router.delete(
  "/users/:userId/delete-user",
  authenticateAdminToken,
  async (req, res) => {
    const startTime = Date.now();
    try {
      const { userId } = req.params;

      const [[user]] = await getPool().execute(
        `SELECT u.id as user_id, u.pensioner_ndx,
              p.id as pensioner_id, p.hero_ndx, p.source_table,
              CONCAT(p.principal_firstname, ' ', p.principal_lastname) as name
       FROM users_tbl u
       LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
       WHERE u.id = ? LIMIT 1`,
        [userId],
      );
      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found",
          code: "USER_NOT_FOUND",
        });
      }

      const deletedRecords = await withTransaction(async (conn) => {
        const [[{ formCount }]] = await conn.execute(
          "SELECT COUNT(*) as formCount FROM form_submission WHERE user_id = ?",
          [userId],
        );

        if (formCount > 0) {
          await conn.execute(
            `DELETE hl FROM history_logs hl
           INNER JOIN form_submission fs ON hl.form_submission_id = fs.id
           WHERE fs.user_id = ?`,
            [userId],
          );
        }

        const [formsResult] = await conn.execute(
          "DELETE FROM form_submission WHERE user_id = ?",
          [userId],
        );
        const [userResult] = await conn.execute(
          "DELETE FROM users_tbl WHERE id = ?",
          [userId],
        );

        let deletedPensioner = false;
        if (user.pensioner_id) {
          const [r] = await conn.execute(
            "DELETE FROM pensioners_tbl WHERE id = ?",
            [user.pensioner_id],
          );
          deletedPensioner = r.affectedRows > 0;
        }

        let deletedFromSourceTable = false;
        if (
          user.hero_ndx &&
          user.source_table &&
          ALL_SOURCE_TABLES.has(user.source_table)
        ) {
          const safeTable = SOURCE_TABLE_MAP[user.source_table];
          const [r] = await conn.execute(
            `DELETE FROM ${safeTable} WHERE NDX = ?`,
            [user.hero_ndx],
          );
          deletedFromSourceTable = r.affectedRows > 0;
        }

        return {
          historyLogs: formCount > 0 ? "deleted" : "none",
          formSubmissions: formsResult.affectedRows,
          user: userResult.affectedRows,
          pensioner: deletedPensioner,
          heroRecord: deletedFromSourceTable,
        };
      });

      res.json({
        success: true,
        message: "User successfully deleted",
        data: {
          userId: parseInt(userId),
          pensionerId: user.pensioner_id,
          heroNdx: user.hero_ndx,
          sourceTable: user.source_table,
          deletedRecords,
        },
        meta: {
          processingTime: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      internalError(res, error, "Failed to delete user");
    }
  },
);

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = { router, authenticateAdminToken, requireSuperAdmin };
