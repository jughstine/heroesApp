const express = require("express");
const { getPool } = require("../config/database");
const router = express.Router();

const IS_PROD = process.env.NODE_ENV === "production";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses and validates a positive integer ID from a string.
 * Returns null if invalid.
 */
const parseId = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const internalError = (res, error, fallback = "Internal server error") => {
  console.error(error);
  res
    .status(500)
    .json({ success: false, error: IS_PROD ? fallback : error.message });
};

// Shared status list used across multiple queries
const ACTIVE_STATUSES =
  "'ACT','UNV','TAG','DEL','DECEASED','AFR','AFB','AFB2','FOR_PAYROLL'";

// ─── Health check ──────────────────────────────────────────────────────────────

router.get("/health", async (_req, res) => {
  const start = Date.now();
  try {
    const conn = await getPool().getConnection();
    await conn.ping();
    conn.release();
    res.json({
      success: true,
      status: "healthy",
      services: { database: "healthy", userProfile: "operational" },
      meta: {
        processingTime: `${Date.now() - start}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: "Health check failed",
      meta: {
        processingTime: `${Date.now() - start}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  }
});

// ─── App config ────────────────────────────────────────────────────────────────

router.get("/app-config", (_req, res) => {
  res.json({
    success: true,
    minimumVersion: "1.4.5",
  });
});

// ─── Profile ───────────────────────────────────────────────────────────────────

router.get("/profile/:userId", async (req, res) => {
  const start = Date.now();
  const userId = parseId(req.params.userId);

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Invalid user ID",
      code: "INVALID_USER_ID",
    });
  }

  const conn = await getPool().getConnection();
  try {
    const [profiles] = await conn.query(
      `SELECT
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.FIRSTNAME
           WHEN p.source_table = 'beneficiaries_table' THEN h3.FIRSTNAME
           ELSE h.FIRSTNAME
         END AS FIRSTNAME,
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.LASTNAME
           WHEN p.source_table = 'beneficiaries_table' THEN h3.LASTNAME
           ELSE h.LASTNAME
         END AS LASTNAME,
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.DOB
           WHEN p.source_table = 'beneficiaries_table' THEN h3.DOB
           ELSE h.DOB
         END AS DOB,
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.TYPE
           WHEN p.source_table = 'beneficiaries_table' THEN h3.TYPE
           ELSE h.TYPE
         END AS TYPE,
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.CTRLNR
           WHEN p.source_table = 'beneficiaries_table' THEN h3.CTRLNR
           ELSE h.CTRLNR
         END AS CTRLNR,
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.MOBILENR
           WHEN p.source_table = 'beneficiaries_table' THEN h3.MOBILENR
           ELSE h.MOBILENR
         END AS MOBILENR,
         -- AFPSN with officer prefix logic
         CASE
           WHEN p.source_table = 'resumption_table' THEN
             CASE WHEN h2.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS','O-W')
               THEN CONCAT('O-', REPLACE(h2.AFPSN, 'O-', '')) ELSE h2.AFPSN END
           WHEN p.source_table = 'beneficiaries_table' THEN
             CASE WHEN h3.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS','O-W')
               THEN CONCAT('O-', REPLACE(h3.AFPSN, 'O-', '')) ELSE h3.AFPSN END
           ELSE
             CASE WHEN h.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','GEN','COMMO','COL','CDR','BGEN','MGEN','LGEN','ADM','VADM','RADM','CAPT','LCDR','LTSG','LTJG','ENS','O-W')
               THEN CONCAT('O-', REPLACE(h.AFPSN, 'O-', '')) ELSE h.AFPSN END
         END AS AFPSN,
         CASE
           WHEN p.source_table = 'resumption_table'    THEN h2.PENRANK
           WHEN p.source_table = 'beneficiaries_table' THEN h3.PENRANK
           ELSE h.PENRANK
         END AS PENRANK,
         p.type AS pensioner_type,
         p.bos,
         p.b_type,
         p.principal_firstname,
         p.principal_lastname,
         u.email,
         u.status,
         u.status_updated_at,
         u.profile_picture,
         u.created_at
       FROM users_tbl u
       JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
       LEFT JOIN heroes_tbl          h  ON p.hero_ndx = h.NDX
       LEFT JOIN resumption_table    h2 ON p.hero_ndx = h2.NDX
       LEFT JOIN beneficiaries_table h3 ON p.hero_ndx = h3.NDX
       WHERE u.id = ?
         AND u.status IN (${ACTIVE_STATUSES})
         AND (p.b_type IS NOT NULL OR p.type != 'B')`,
      [userId],
    );

    if (profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        code: "PROFILE_NOT_FOUND",
      });
    }

    const p = profiles[0];
    res.json({
      success: true,
      FIRSTNAME: p.FIRSTNAME,
      LASTNAME: p.LASTNAME,
      DOB: p.DOB,
      TYPE: p.TYPE,
      AFPSN: p.AFPSN,
      BOS: p.bos,
      EMAIL: p.email,
      MOBILENR: p.MOBILENR,
      CTRLNR: p.CTRLNR,
      email: p.email,
      status: p.status,
      status_updated_at: p.status_updated_at,
      profile_picture: p.profile_picture,
      b_type: p.b_type,
      pensioner_type: p.pensioner_type,
      ...(p.pensioner_type === "B" && {
        beneficiary_info: {
          b_type: p.b_type,
          principal_firstname: p.principal_firstname,
          principal_lastname: p.principal_lastname,
        },
      }),
      meta: {
        processingTime: `${Date.now() - start}ms`,
        retrieved: new Date().toISOString(),
      },
    });
  } catch (error) {
    internalError(res, error, "Failed to retrieve user profile");
  } finally {
    conn.release();
  }
});

// ─── Profile picture ───────────────────────────────────────────────────────────

const ALLOWED_STATUSES = new Set([
  "ACT",
  "UNV",
  "TAG",
  "DEL",
  "DECEASED",
  "AFR",
  "AFB",
  "AFB2",
  "FOR_PAYROLL",
]);

const isValidUrl = (str) => {
  try {
    const u = new URL(str);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

router.put("/profile/:userId/picture", async (req, res) => {
  const start = Date.now();
  const userId = parseId(req.params.userId);

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Invalid user ID",
      code: "INVALID_USER_ID",
    });
  }

  const { profile_picture } = req.body;
  if (!profile_picture || !isValidUrl(profile_picture)) {
    return res.status(400).json({
      success: false,
      error: "Valid profile picture URL required",
      code: "INVALID_URL",
    });
  }

  const conn = await getPool().getConnection();
  try {
    const [[user]] = await conn.query(
      "SELECT id, status FROM users_tbl WHERE id = ?",
      [userId],
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
      });
    }
    if (!ALLOWED_STATUSES.has(user.status)) {
      return res.status(403).json({
        success: false,
        error: "Account status does not allow profile updates",
        code: "FORBIDDEN_STATUS",
      });
    }

    await conn.query("UPDATE users_tbl SET profile_picture = ? WHERE id = ?", [
      profile_picture,
      userId,
    ]);

    res.json({
      success: true,
      data: { profile_picture },
      message: "Profile picture updated successfully",
      meta: {
        processingTime: `${Date.now() - start}ms`,
        updated: new Date().toISOString(),
      },
    });
  } catch (error) {
    internalError(res, error, "Failed to update profile picture");
  } finally {
    conn.release();
  }
});

// ─── Submissions ───────────────────────────────────────────────────────────────

router.get("/submissions/:userId", async (req, res) => {
  const start = Date.now();
  const userId = parseId(req.params.userId);

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Invalid user ID",
      code: "INVALID_USER_ID",
    });
  }

  const conn = await getPool().getConnection();
  try {
    // Verify user exists in one query — no separate health check round-trip
    const [[user]] = await conn.query(
      `SELECT u.id, p.source_table
       FROM users_tbl u
       JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
       WHERE u.id = ? AND u.status IN (${ACTIVE_STATUSES})`,
      [userId],
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
      });
    }

    const [rows] = await conn.query(
      `SELECT
         fs.id,
         fs.form_reference,
         fs.form_type_id,
         fs.status,
         CONVERT_TZ(fs.submitted_at, @@session.time_zone, '+00:00') AS submitted_at,
         CONVERT_TZ(fs.reviewed_at,  @@session.time_zone, '+00:00') AS reviewed_at,
         fs.admin_notes,
         fs.latitude,
         fs.longitude,
         (fs.resolution_file_url IS NOT NULL AND fs.resolution_file_url != '') AS has_resolution_file,
         COALESCE(fs.resolution_download_count, 0) AS resolution_download_count
       FROM form_submission fs
       WHERE fs.user_id = ? AND fs.status IN ('p','a','d')
       ORDER BY fs.submitted_at DESC`,
      [userId],
    );

    const submissions = rows.map((s) => ({
      ...s,
      submitted_at: s.submitted_at
        ? new Date(s.submitted_at).toISOString()
        : null,
      reviewed_at: s.reviewed_at ? new Date(s.reviewed_at).toISOString() : null,
      has_resolution_file: Boolean(s.has_resolution_file),
      resolution_download_count: s.resolution_download_count || 0,
    }));

    res.json({
      success: true,
      data: submissions,
      meta: {
        userId,
        count: submissions.length,
        processingTime: `${Date.now() - start}ms`,
        retrieved: new Date().toISOString(),
      },
    });
  } catch (error) {
    internalError(res, error, "Failed to retrieve user submissions");
  } finally {
    conn.release();
  }
});

// ─── Resolution file download ──────────────────────────────────────────────────

const MAX_DOWNLOADS = 1;

router.get("/submissions/:submissionId/resolution-file", async (req, res) => {
  const start = Date.now();
  const submissionId = parseId(req.params.submissionId);
  const userId = parseId(req.query.userId);

  if (!submissionId) {
    return res.status(400).json({
      success: false,
      error: "Invalid submission ID",
      code: "INVALID_SUBMISSION_ID",
    });
  }
  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "User ID is required",
      code: "USER_ID_REQUIRED",
    });
  }

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [[submission]] = await conn.query(
      `SELECT id, user_id, form_type_id, status, resolution_file_url,
              COALESCE(resolution_download_count, 0) AS download_count
       FROM form_submission
       WHERE id = ? AND user_id = ? AND form_type_id = 1 AND status = 'a'`,
      [submissionId, userId],
    );

    if (!submission) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: "Resolution file is only available for approved declarations",
        code: "ACCESS_DENIED",
      });
    }

    if (submission.download_count >= MAX_DOWNLOADS) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: "Download limit reached. You can only download this file once.",
        code: "DOWNLOAD_LIMIT_EXCEEDED",
        downloadCount: submission.download_count,
        maxDownloads: MAX_DOWNLOADS,
      });
    }

    if (!submission.resolution_file_url) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        error: "Resolution file not available for this submission",
        code: "NO_RESOLUTION_FILE",
      });
    }

    await conn.query(
      "UPDATE form_submission SET resolution_download_count = resolution_download_count + 1 WHERE id = ?",
      [submissionId],
    );
    await conn.commit();

    const newCount = submission.download_count + 1;
    res.json({
      success: true,
      data: {
        submissionId: submission.id,
        fileUrl: submission.resolution_file_url,
        downloadCount: newCount,
        remainingDownloads: Math.max(0, MAX_DOWNLOADS - newCount),
      },
      message:
        newCount < MAX_DOWNLOADS
          ? `You have ${MAX_DOWNLOADS - newCount} download(s) remaining.`
          : "This is your last download.",
      processingTime: `${Date.now() - start}ms`,
    });
  } catch (error) {
    try {
      await conn.rollback();
    } catch {}
    internalError(res, error, "Failed to retrieve resolution file");
  } finally {
    conn.release();
  }
});

// ─── Form types ────────────────────────────────────────────────────────────────

router.get("/form-types", (_req, res) => {
  res.json({
    success: true,
    data: {
      1: "Updating",
      2: "Restoration",
      3: "Resumption",
      4: "Transfer of Pension",
      5: "Declaration of Legal Beneficiary",
    },
  });
});

// ─── Push token ────────────────────────────────────────────────────────────────

router.put("/push-token/:userId", async (req, res) => {
  const start = Date.now();
  const userId = parseId(req.params.userId);

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Invalid user ID",
      code: "INVALID_USER_ID",
    });
  }

  const { push_token } = req.body;
  if (
    !push_token ||
    typeof push_token !== "string" ||
    push_token.trim().length === 0
  ) {
    return res.status(400).json({
      success: false,
      error: "Valid push token is required",
      code: "INVALID_TOKEN",
    });
  }

  const conn = await getPool().getConnection();
  try {
    const [[user]] = await conn.query(
      `SELECT id FROM users_tbl WHERE id = ? AND status IN (${ACTIVE_STATUSES})`,
      [userId],
    );
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
      });
    }

    await conn.query("UPDATE users_tbl SET push_token = ? WHERE id = ?", [
      push_token.trim(),
      userId,
    ]);

    res.json({
      success: true,
      message: "Push token saved successfully",
      meta: {
        processingTime: `${Date.now() - start}ms`,
        updated: new Date().toISOString(),
      },
    });
  } catch (error) {
    internalError(res, error, "Failed to save push token");
  } finally {
    conn.release();
  }
});

router.delete("/push-token/:userId", async (req, res) => {
  const start = Date.now();
  const userId = parseId(req.params.userId);

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Invalid user ID",
      code: "INVALID_USER_ID",
    });
  }

  const conn = await getPool().getConnection();
  try {
    await conn.query("UPDATE users_tbl SET push_token = NULL WHERE id = ?", [
      userId,
    ]);
    res.json({
      success: true,
      message: "Push token removed successfully",
      meta: {
        processingTime: `${Date.now() - start}ms`,
        updated: new Date().toISOString(),
      },
    });
  } catch (error) {
    internalError(res, error, "Failed to remove push token");
  } finally {
    conn.release();
  }
});

module.exports = router;
