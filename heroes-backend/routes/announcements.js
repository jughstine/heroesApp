const express = require("express");
const router = express.Router();
const { getPool } = require("../config/database");
const { minioClient } = require("./upload");
const {
  sendFCMAnnouncementBatch,
} = require("../services/pushNotificationService");
const { checkDatabaseHealth } = require("../config/database");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const path = require("path");
const { v4: uuidv4 } = require("uuid"); // npm i uuid  (already likely installed)

/**
 * Sanitise an original filename: strip directory components, keep only the
 * extension, and prepend a UUID so the name is both safe and unique.
 */
function safeFileName(folder, originalName) {
  const ext = path
    .extname(originalName)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  return `${folder}/${uuidv4()}${ext}`;
}

// ─── Validation middleware ─────────────────────────────────────────────────────

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TITLE_MAX = 100;
const DESC_MAX = 300;

function validateAnnouncementBody(req, res, next) {
  const { title, description, link_url } = req.body;

  if (!title || !title.trim()) {
    return res
      .status(400)
      .json({ success: false, error: "Title is required." });
  }
  if (title.trim().length > TITLE_MAX) {
    return res.status(400).json({
      success: false,
      error: `Title must be under ${TITLE_MAX} characters.`,
    });
  }
  if (description && description.length > DESC_MAX) {
    return res.status(400).json({
      success: false,
      error: `Description must be under ${DESC_MAX} characters.`,
    });
  }
  if (link_url && link_url.trim()) {
    try {
      const u = new URL(link_url.trim());
      if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    } catch {
      return res.status(400).json({
        success: false,
        error: "link_url must be a valid http/https URL.",
      });
    }
  }
  if (req.file) {
    if (!ALLOWED_MIME.has(req.file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: "Only JPEG, PNG, GIF, or WebP images are allowed.",
      });
    }
    if (req.file.size > MAX_BYTES) {
      return res
        .status(400)
        .json({ success: false, error: "Image must be under 5 MB." });
    }
  }

  next();
}

// ─── Shared image-upload helper ───────────────────────────────────────────────

async function uploadImageToSpaces(file) {
  const fileName = safeFileName("announcements", file.originalname);

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

  return `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_REGION || "sgp1"}.digitaloceanspaces.com/${fileName}`;
}

// ─── GET /announcements  (with pagination) ──────────────────────────────

router.get("/announcements", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;

  let conn = null;
  try {
    const pool = getPool();
    conn = await pool.getConnection();

    const [[{ total }]] = await conn.execute(
      "SELECT COUNT(*) AS total FROM announcements",
    );
    const [rows] = await conn.query(
      `SELECT * FROM announcements ORDER BY display_order ASC, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    );

    res.json({
      success: true,
      data: rows,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("GET /announcements error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch announcements." });
  } finally {
    conn?.release();
  }
});

// ─── POST /announcements ────────────────────────────────────────────────

router.post(
  "/announcements",
  upload.single("image"),
  validateAnnouncementBody,
  async (req, res) => {
    const startTime = Date.now();
    let conn = null;

    try {
      const { title, description, link_url, is_active, display_order } =
        req.body;

      const dbHealthy = await checkDatabaseHealth();
      if (!dbHealthy) {
        return res.status(503).json({
          success: false,
          error:
            "Database service temporarily unavailable. Please try again later.",
          code: "DB_UNAVAILABLE",
        });
      }

      const pool = getPool();
      conn = await pool.getConnection();

      // Upload image (if provided)
      let image_url = null;
      if (req.file) {
        image_url = await uploadImageToSpaces(req.file);
      }

      const isActive = is_active === "true" || is_active === true;

      const [result] = await conn.execute(
        `INSERT INTO announcements (title, description, image_url, link_url, is_active, display_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          title.trim(),
          description?.trim() || null,
          image_url,
          link_url?.trim() || null,
          isActive,
          parseInt(display_order) || 0,
        ],
      );

      const [[created]] = await conn.execute(
        "SELECT * FROM announcements WHERE id = ?",
        [result.insertId],
      );

      // Send FCM notifications (fire-and-forget; never fails the request)
      const notificationStatus = {
        sent: false,
        recipientCount: 0,
        successCount: 0,
        failureCount: 0,
      };
      if (created.is_active) {
        sendAnnouncementNotifications(conn, created, notificationStatus).catch(
          (err) => console.error("FCM notification error:", err),
        );
      }

      res.json({
        success: true,
        data: created,
        notifications: notificationStatus,
        meta: { processingTime: `${Date.now() - startTime}ms` },
      });
    } catch (error) {
      console.error("POST /announcements error:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to create announcement",
        code: "SERVER_ERROR",
      });
    } finally {
      conn?.release();
    }
  },
);

// ─── PATCH /announcements/:id  (update) ─────────────────────────────────

router.patch(
  "/announcements/:id",
  upload.single("image"),
  validateAnnouncementBody,
  async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid ID." });

    let conn = null;
    try {
      const pool = getPool();
      conn = await pool.getConnection();

      const [[existing]] = await conn.execute(
        "SELECT * FROM announcements WHERE id = ?",
        [id],
      );
      if (!existing) {
        return res
          .status(404)
          .json({ success: false, error: "Announcement not found." });
      }

      const { title, description, link_url, is_active, display_order } =
        req.body;

      let image_url = existing.image_url;
      if (req.file) {
        image_url = await uploadImageToSpaces(req.file);
        // Optionally: delete the old image from Spaces here
      }

      await conn.execute(
        `UPDATE announcements
         SET title = ?, description = ?, image_url = ?, link_url = ?,
             is_active = ?, display_order = ?
         WHERE id = ?`,
        [
          title.trim(),
          description?.trim() || null,
          image_url,
          link_url?.trim() || null,
          is_active === "true" || is_active === true,
          parseInt(display_order) || 0,
          id,
        ],
      );

      const [[updated]] = await conn.execute(
        "SELECT * FROM announcements WHERE id = ?",
        [id],
      );

      res.json({ success: true, data: updated });
    } catch (error) {
      console.error(`PATCH /announcements/${id} error:`, error);
      res
        .status(500)
        .json({ success: false, error: "Failed to update announcement." });
    } finally {
      conn?.release();
    }
  },
);

// ─── PATCH /announcements/:id/toggle ────────────────────────────────────

router.patch("/announcements/:id/toggle", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id)
    return res.status(400).json({ success: false, error: "Invalid ID." });

  let conn = null;
  try {
    const pool = getPool();
    conn = await pool.getConnection();

    const [[row]] = await conn.execute(
      "SELECT id, is_active FROM announcements WHERE id = ?",
      [id],
    );
    if (!row)
      return res
        .status(404)
        .json({ success: false, error: "Announcement not found." });

    await conn.execute("UPDATE announcements SET is_active = ? WHERE id = ?", [
      !row.is_active,
      id,
    ]);

    res.json({ success: true, data: { id, is_active: !row.is_active } });
  } catch (error) {
    console.error(`PATCH /announcements/${id}/toggle error:`, error);
    res.status(500).json({ success: false, error: "Failed to toggle status." });
  } finally {
    conn?.release();
  }
});

// ─── DELETE /announcements/:id ──────────────────────────────────────────

router.delete("/announcements/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id)
    return res.status(400).json({ success: false, error: "Invalid ID." });

  let conn = null;
  try {
    const pool = getPool();
    conn = await pool.getConnection();

    const [[row]] = await conn.execute(
      "SELECT id FROM announcements WHERE id = ?",
      [id],
    );
    if (!row)
      return res
        .status(404)
        .json({ success: false, error: "Announcement not found." });

    await conn.execute("DELETE FROM announcements WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(`DELETE /announcements/${id} error:`, error);
    res
      .status(500)
      .json({ success: false, error: "Failed to delete announcement." });
  } finally {
    conn?.release();
  }
});

// ─── PUT /announcements/reorder ─────────────────────────────────────────
// Body: [{ id: number, display_order: number }, ...]

router.put("/announcements/reorder", async (req, res) => {
  const items = req.body;
  if (
    !Array.isArray(items) ||
    items.some(
      (i) => !Number.isInteger(i.id) || !Number.isInteger(i.display_order),
    )
  ) {
    return res.status(400).json({
      success: false,
      error: "Body must be an array of { id, display_order }.",
    });
  }

  let conn = null;
  try {
    const pool = getPool();
    conn = await pool.getConnection();
    await conn.beginTransaction();

    for (const { id, display_order } of items) {
      await conn.execute(
        "UPDATE announcements SET display_order = ? WHERE id = ?",
        [display_order, id],
      );
    }

    await conn.commit();
    res.json({ success: true });
  } catch (error) {
    await conn?.rollback();
    console.error("PUT /announcements/reorder error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to reorder announcements." });
  } finally {
    conn?.release();
  }
});

// ─── GET all active announcements (for mobile app) ─────────────────────────────────────────

router.get("/announcements", async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error:
          "Database service temporarily unavailable. Please try again later.",
        code: "DB_UNAVAILABLE",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();

    const [rows] = await conn.execute(
      `SELECT id, title, description, image_url, link_url, is_active, 
              display_order, created_at, updated_at
       FROM announcements 
       WHERE is_active = true 
       ORDER BY display_order ASC, created_at DESC`,
    );

    res.json({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        processingTime: `${Date.now() - startTime}ms`,
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("Error fetching announcements:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch announcements",
      code: "SERVER_ERROR",
      processingTime: `${processingTime}ms`,
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// ─── Internal: send FCM (extracted to keep routes clean) ─────────────────────

async function sendAnnouncementNotifications(conn, announcement, statusOut) {
  const [rows] = await conn.execute(`
    SELECT DISTINCT fcm_token FROM users_tbl
    WHERE fcm_token IS NOT NULL AND TRIM(fcm_token) != ''
  `);

  const tokens = [
    ...new Set(rows.map((r) => r.fcm_token?.trim()).filter(Boolean)),
  ];
  if (!tokens.length) return;

  const result = await sendFCMAnnouncementBatch(tokens, announcement);
  statusOut.sent = result.successCount > 0;
  statusOut.recipientCount = tokens.length;
  statusOut.successCount = result.successCount || 0;
  statusOut.failureCount = result.failureCount || 0;
}

module.exports = router;
