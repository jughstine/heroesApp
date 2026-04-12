const express = require("express");
const { getPool } = require("../config/database");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Database connection health check
const checkDatabaseHealth = async () => {
  try {
    const poolInstance = getPool();
    const conn = await poolInstance.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
};

// Health check endpoint
router.get("/health", async (req, res) => {
  const startTime = Date.now();

  try {
    const dbHealthy = await checkDatabaseHealth();
    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      status: "healthy",
      services: {
        database: dbHealthy ? "healthy" : "degraded",
        userProfile: "operational",
      },
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;

    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: "Health check failed",
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  }
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "../uploads/profile-pictures");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${req.params.userId}_${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif"];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error("Invalid file type. Only JPEG, PNG and GIF are allowed."),
      false,
    );
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// User Profile endpoint
router.get("/profile", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
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

    // Get database connection
    conn = await poolInstance.getConnection();

    const [profiles] = await conn.query(`
      SELECT 
        COALESCE(h.FIRSTNAME, h2.FIRSTNAME) AS FIRSTNAME,
        COALESCE(h.LASTNAME, h2.LASTNAME) AS LASTNAME,
        COALESCE(h.DOB, h2.DOB) AS DOB,
        COALESCE(h.TYPE, h2.TYPE) AS TYPE,
        COALESCE(h.AFPSN, h2.AFPSN) AS AFPSN,
        COALESCE(h.MOBILENR, h2.MOBILENR) AS MOBILENR,
        u.email,
        u.status,
        u.created_at
      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN heroes_tbl h ON p.hero_ndx = h.NDX AND p.source_table = 'heroes_tbl'
      LEFT JOIN resumption_table h2 ON p.hero_ndx = h2.NDX AND p.source_table = 'resumption_table'
      WHERE u.status IN ('ACT', 'UNV', 'TAG', 'DEL', 'DECEASED', 'AFB', 'AFB2', 'AFR', 'FOR_PAYROLL')
      ORDER BY u.created_at DESC
      LIMIT 1
    `);

    if (profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        code: "PROFILE_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const profile = profiles[0];

    const processingTime = Date.now() - startTime;

    const profileResponse = {
      success: true,
      data: {
        FIRSTNAME: profile.FIRSTNAME,
        LASTNAME: profile.LASTNAME,
        DOB: profile.DOB,
        TYPE: profile.TYPE,
        MOBILENR: profile.MOBILENR,
        status: profile.status,
        AFPSN: profile.AFPSN,
      },
      meta: {
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString(),
      },
    };

    res.json(profileResponse);
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PROFILE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve user profile",
      code: "PROFILE_ERROR",
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

// Profile endpoint with user ID parameter
router.get("/profile/:userId", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const userId = req.params.userId;

    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: "INVALID_USER_ID",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

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

    conn = await poolInstance.getConnection();

    const [profiles] = await conn.query(
      `
      SELECT 
        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN h3.FIRSTNAME
          ELSE h.FIRSTNAME 
        END AS FIRSTNAME,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN h3.LASTNAME
          ELSE h.LASTNAME 
        END AS LASTNAME,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.DOB
          WHEN p.source_table = 'beneficiaries_table' THEN h3.DOB
          ELSE h.DOB 
        END AS DOB,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN 
            CASE 
              WHEN h2.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'GEN', 'COMMO', 'COL', 'CDR', 'BGEN', 'MGEN', 'LGEN', 'ADM', 'VADM', 'RADM', 'CAPT', 'CDR', 'LCDR', 'LTSG', 'LTJG', 'ENS') 
                THEN CONCAT('O-', REPLACE(h2.AFPSN, 'O-', ''))
              ELSE h2.AFPSN
            END
          WHEN p.source_table = 'beneficiaries_table' THEN
            CASE 
              WHEN h3.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'GEN', 'COMMO', 'COL', 'CDR', 'BGEN', 'MGEN', 'LGEN', 'ADM', 'VADM', 'RADM', 'CAPT', 'CDR', 'LCDR', 'LTSG', 'LTJG', 'ENS') 
                THEN CONCAT('O-', REPLACE(h3.AFPSN, 'O-', ''))
              ELSE h3.AFPSN
            END
          ELSE 
            CASE 
              WHEN h.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'GEN', 'COMMO', 'COL', 'CDR', 'BGEN', 'MGEN', 'LGEN', 'ADM', 'VADM', 'RADM', 'CAPT', 'CDR', 'LCDR', 'LTSG', 'LTJG', 'ENS') 
                THEN CONCAT('O-', REPLACE(h.AFPSN, 'O-', ''))
              ELSE h.AFPSN
            END
        END AS afpsn,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN h3.PENRANK
          ELSE h.PENRANK 
        END AS penrank,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.TYPE
          WHEN p.source_table = 'beneficiaries_table' THEN h3.TYPE
          ELSE h.TYPE 
        END AS TYPE,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.CTRLNR
          WHEN p.source_table = 'beneficiaries_table' THEN h3.CTRLNR
          ELSE h.CTRLNR 
        END AS CTRLNR,

        CASE 
          WHEN p.source_table = 'resumption_table' THEN h2.MOBILENR
          WHEN p.source_table = 'beneficiaries_table' THEN h3.MOBILENR
          ELSE h.MOBILENR 
        END AS MOBILENR,

        p.type AS pensioner_type,
        p.bos,  
        p.b_type,
        p.principal_firstname,
        p.principal_lastname,
        p.source_table,
        u.email,
        u.status,
        u.status_updated_at,
        u.profile_picture,
        u.created_at
      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN heroes_tbl h ON p.hero_ndx = h.NDX
      LEFT JOIN resumption_table h2 ON p.hero_ndx = h2.NDX
      LEFT JOIN beneficiaries_table h3 ON p.hero_ndx = h3.NDX
      WHERE u.id = ? 
        AND u.status IN ('ACT', 'UNV', 'AFB', 'AFB2', 'TAG', 'DEL', 'DECEASED', 'AFR', 'FOR_PAYROLL')
  AND (p.b_type IS NOT NULL OR p.type != 'B')

    `,
      [userId],
    );

    if (profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        code: "PROFILE_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const profile = profiles[0];

    const heroData = {
      FIRSTNAME: profile.FIRSTNAME,
      LASTNAME: profile.LASTNAME,
      DOB: profile.DOB,
      AFPSN: profile.afpsn,
      PENRANK: profile.penrank,
      TYPE: profile.TYPE,
      CTRLNR: profile.CTRLNR,
      MOBILENR: profile.MOBILENR,
    };

    const processingTime = Date.now() - startTime;

    const profileResponse = {
      success: true,
      FIRSTNAME: heroData.FIRSTNAME,
      TYPE: heroData.TYPE,
      DOB: heroData.DOB,
      LASTNAME: heroData.LASTNAME,
      AFPSN: heroData.AFPSN,
      BOS: profile.bos,
      EMAIL: profile.email,
      MOBILENR: heroData.MOBILENR,
      CTRLNR: heroData.CTRLNR,
      email: profile.email,
      status: profile.status,
      status_updated_at: profile.status_updated_at,
      profile_picture: profile.profile_picture,
      b_type: profile.b_type,
      pensioner_type: profile.pensioner_type,
      source_table: profile.source_table,
      ...(profile.pensioner_type === "B" && {
        beneficiary_info: {
          b_type: profile.b_type,
          principal_firstname: profile.principal_firstname,
          principal_lastname: profile.principal_lastname,
        },
      }),
      meta: {
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString(),
      },
    };

    res.json(profileResponse);
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PROFILE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve user profile",
      code: "PROFILE_ERROR",
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

router.put("/profile/:userId/picture", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const userId = req.params.userId;
    const { profile_picture } = req.body;

    // Validate userId
    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: "INVALID_USER_ID",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    if (!profile_picture || typeof profile_picture !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid profile picture URL is required",
        code: "INVALID_URL",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable",
        code: "DB_UNAVAILABLE",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    conn = await poolInstance.getConnection();

    // Verify user exists with better debugging
    const [users] = await conn.query(
      "SELECT id, status FROM users_tbl WHERE id = ?",
      [userId],
    );

    if (users.length === 0) {
      console.warn(`User not found: userId=${userId}`);
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const user = users[0];

    // Check if user status allows profile updates
    const allowedStatuses = [
      "ACT",
      "UNV",
      "TAG",
      "DEL",
      "DECEASED",
      "AFR",
      "AFB",
      "AFB2",
      "FOR_PAYROLL",
    ];
    if (!allowedStatuses.includes(user.status)) {
      console.warn(
        `User status not allowed for update: userId=${userId}, status=${user.status}`,
      );
      return res.status(403).json({
        success: false,
        error: "Your account status does not allow profile updates",
        code: "FORBIDDEN_STATUS",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Update user profile with new picture URL
    await conn.query("UPDATE users_tbl SET profile_picture = ? WHERE id = ?", [
      profile_picture,
      userId,
    ]);

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      data: {
        profile_picture: profile_picture,
      },
      message: "Profile picture updated successfully",
      meta: {
        processingTime: `${processingTime}ms`,
        updated: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PROFILE PICTURE UPDATE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to update profile picture",
      code: "UPDATE_ERROR",
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

// Form submissions endpoint
router.get("/submissions", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = ll;

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

    // Get database connection
    conn = await poolInstance.getConnection();

    // This gets submissions for the most recent userr
    const [submissions] = await conn.query(`
      SELECT 
        fs.id,
        fs.form_reference,
        fs.form_type_id,
        fs.status,
        fs.submitted_at,
        fs.latitude,
        fs.longitude
      FROM form_submission fs
      JOIN users_tbl u ON fs.user_id = u.id
      WHERE u.status IN ('ACT', 'UNV', 'TAG', 'DEL', 'DECEASED', 'AFR','AFB', 'AFB2', 'FOR_PAYROLL')
      AND fs.status IN ('p', 'a', 'd') 
      ORDER BY fs.submitted_at DESC
    `);

    const processingTime = Date.now() - startTime;

    const submissionsResponse = {
      success: true,
      data: submissions,
      meta: {
        count: submissions.length,
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString(),
      },
    };

    res.json(submissionsResponse);
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== FORM SUBMISSIONS ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve form submissions",
      code: "SUBMISSIONS_ERROR",
      processingTime: `${Date.now() - startTime}ms`,
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

// Get user submissions endpoint
router.get("/submissions/:userId", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const userId = req.params.userId;

    // Validate userId
    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: "INVALID_USER_ID",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

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

    conn = await poolInstance.getConnection();

    // Verify user exists (works with both tables)
    const [userExists] = await conn.query(
      `
      SELECT u.id, p.source_table
      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      WHERE u.id = ? AND u.status IN ('ACT', 'UNV', 'TAG', 'DEL', 'DECEASED', 'AFR','AFB', 'AFB2', 'FOR_PAYROLL')
    `,
      [userId],
    );

    if (userExists.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Query for specific user's submissions with UTC timezone conversion AND download count
    const [submissions] = await conn.query(
      `
      SELECT 
        fs.id,
        fs.form_reference,
        fs.form_type_id,
        fs.status,
        CONVERT_TZ(fs.submitted_at, @@session.time_zone, '+00:00') as submitted_at,
        CONVERT_TZ(fs.reviewed_at, @@session.time_zone, '+00:00') as reviewed_at,
        fs.admin_notes,
        fs.latitude,
        fs.longitude,
        CASE 
          WHEN fs.resolution_file_url IS NOT NULL AND fs.resolution_file_url != '' 
          THEN TRUE 
          ELSE FALSE 
        END as has_resolution_file,
        COALESCE(fs.resolution_download_count, 0) as resolution_download_count
      FROM form_submission fs
      WHERE fs.user_id = ?
      AND fs.status IN ('p', 'a', 'd')
      ORDER BY fs.submitted_at DESC
    `,
      [userId],
    );

    // Ensure timestamps are in ISO 8601 format
    const normalizedSubmissions = submissions.map((submission) => ({
      ...submission,
      submitted_at: submission.submitted_at
        ? new Date(submission.submitted_at).toISOString()
        : null,
      reviewed_at: submission.reviewed_at
        ? new Date(submission.reviewed_at).toISOString()
        : null,
      has_resolution_file: Boolean(submission.has_resolution_file),
      resolution_download_count: submission.resolution_download_count || 0,
    }));

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      data: normalizedSubmissions,
      meta: {
        userId: parseInt(userId),
        count: normalizedSubmissions.length,
        source_table: userExists[0].source_table,
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== USER SUBMISSIONS ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve user submissions",
      code: "USER_SUBMISSIONS_ERROR",
      processingTime: `${Date.now() - startTime}ms`,
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

// secure download resolution file
router.get("/submissions/:submissionId/resolution-file", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const submissionId = req.params.submissionId;
    const userId = req.query.userId;

    // Validate parameters
    if (isNaN(submissionId) || submissionId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid submission ID provided",
        code: "INVALID_SUBMISSION_ID",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    if (!userId || isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
        code: "USER_ID_REQUIRED",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    conn = await poolInstance.getConnection();

    // Start transaction to ensure atomic operations
    await conn.beginTransaction();

    // Verify the submission belongs to the user and get current download count
    // SECURITY: Only allow access for APPROVED (status = 'a') Declaration forms (form_type_id = 1)
    const [submissions] = await conn.query(
      `
      SELECT 
        fs.id,
        fs.user_id,
        fs.form_type_id,
        fs.status,
        fs.resolution_file_url,
        COALESCE(fs.resolution_download_count, 0) as download_count
      FROM form_submission fs
      WHERE fs.id = ? 
        AND fs.user_id = ?
        AND fs.form_type_id = 1
        AND fs.status = 'a'
    `,
      [submissionId, userId],
    );

    if (submissions.length === 0) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: "Resolution file is only available for approved declarations",
        code: "ACCESS_DENIED",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const submission = submissions[0];
    const currentDownloadCount = submission.download_count;

    // Check if download limit exceeded
    if (currentDownloadCount >= 1) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: "Download limit reached. You can only download this file once.",
        code: "DOWNLOAD_LIMIT_EXCEEDED",
        downloadCount: currentDownloadCount,
        maxDownloads: 1,
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Check if resolution file exists
    if (!submission.resolution_file_url) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        error: "Resolution file not available for this submission",
        code: "NO_RESOLUTION_FILE",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Increment download count
    await conn.query(
      `
      UPDATE form_submission 
      SET resolution_download_count = resolution_download_count + 1
      WHERE id = ?
    `,
      [submissionId],
    );

    // Commit transaction
    await conn.commit();

    const newDownloadCount = currentDownloadCount + 1;
    const remainingDownloads = 2 - newDownloadCount;

    res.json({
      success: true,
      data: {
        submissionId: submission.id,
        fileUrl: submission.resolution_file_url,
        downloadCount: newDownloadCount,
        remainingDownloads: remainingDownloads,
      },
      message:
        remainingDownloads > 0
          ? `You have ${remainingDownloads} download(s) remaining.`
          : "This is your last download.",
      processingTime: `${Date.now() - startTime}ms`,
    });
  } catch (error) {
    // Rollback transaction on error
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }

    console.error("=== RESOLUTION FILE DOWNLOAD ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve resolution file",
      code: "RESOLUTION_FILE_ERROR",
      processingTime: `${Date.now() - startTime}ms`,
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

// Form types reference endpoint
router.get("/form-types", async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        1: "Updating",
        2: "Restoration",
        3: "Resumption",
        4: "Transfer of Pension",
        5: "Declaration of Legal Beneficiary",
      },
      message:
        "Form type ID mapping. Adjust these IDs based on your form_types table.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to retrieve form types",
    });
  }
});

// Update user's push token
router.put("/push-token/:userId", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const userId = req.params.userId;
    const { push_token } = req.body;

    // Validate userId
    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: "INVALID_USER_ID",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    if (!push_token || typeof push_token !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid push token is required",
        code: "INVALID_TOKEN",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable",
        code: "DB_UNAVAILABLE",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    conn = await poolInstance.getConnection();

    // Verify user exists
    const [users] = await conn.query(
      "SELECT id FROM users_tbl WHERE id = ? AND status IN ('ACT', 'UNV', 'TAG', 'DEL', 'DECEASED', 'AFR', 'AFB', 'AFB2', 'FOR_PAYROLL')",
      [userId],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // Update user's push token
    await conn.query("UPDATE users_tbl SET push_token = ? WHERE id = ?", [
      push_token,
      userId,
    ]);

    const processingTime = Date.now() - startTime;
    res.json({
      success: true,
      message: "Push token saved successfully",
      meta: {
        processingTime: `${processingTime}ms`,
        updated: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PUSH TOKEN UPDATE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to save push token",
      code: "UPDATE_ERROR",
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

// Delete user's push token (for logout)
router.delete("/push-token/:userId", async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const userId = req.params.userId;

    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: "INVALID_USER_ID",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    conn = await poolInstance.getConnection();

    await conn.query("UPDATE users_tbl SET push_token = NULL WHERE id = ?", [
      userId,
    ]);

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      message: "Push token removed successfully",
      meta: {
        processingTime: `${processingTime}ms`,
        updated: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PUSH TOKEN DELETE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to remove push token",
      code: "DELETE_ERROR",
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

module.exports = router;
