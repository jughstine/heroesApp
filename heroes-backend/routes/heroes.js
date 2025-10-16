const express = require('express');
const { getPool } = require('../config/database');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');


// Database connection health check
const checkDatabaseHealth = async () => {
  try {
    const poolInstance = getPool(); 
    const conn = await poolInstance.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};

// Health check endpoint
router.get('/health', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const dbHealthy = await checkDatabaseHealth();
    const processingTime = Date.now() - startTime;
    
    res.json({
      success: true,
      status: 'healthy',
      services: {
        database: dbHealthy ? 'healthy' : 'degraded',
        userProfile: 'operational'
      },
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: 'Health check failed',
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      }
    });
  }
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/profile-pictures');
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Create unique filename: userId_timestamp.ext
    const uniqueName = `${req.params.userId}_${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG and GIF are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});


// User Profile endpoint
router.get('/profile', async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool(); 
  let conn = null;

  try {    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Get database connection
    conn = await poolInstance.getConnection();
    
    // Updated query to include DOB and TYPE
    const [profiles] = await conn.query(`
      SELECT 
        h.FIRSTNAME,
        h.LASTNAME,
        h.DOB,
        h.TYPE,
        h.AFPSN,
        h.MOBILENR,
        u.email,
        u.status,
        u.created_at
      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      JOIN test_table h ON p.hero_ndx = h.NDX
      WHERE u.status IN ('ACT', 'UNV', 'TAG', 'DEL')
      ORDER BY u.created_at DESC
      LIMIT 1
    `);

    if (profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        code: 'PROFILE_NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const profile = profiles[0];
    
    const processingTime = Date.now() - startTime;

    // Updated response to include DOB and TYPE
    const profileResponse = {
      success: true,
      data: {
        FIRSTNAME: profile.FIRSTNAME,
        LASTNAME: profile.LASTNAME,
        DOB: profile.DOB,
        TYPE: profile.TYPE,
        MOBILENR: profile.MOBILENR,
        status: profile.status,
        AFPSN: profile.AFPSN
      },
      meta: {
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString()
      }
    };

    res.json(profileResponse);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PROFILE ERROR ==="); 
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve user profile",
      code: 'PROFILE_ERROR',
      processingTime: `${processingTime}ms`
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
router.get('/profile/:userId', async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool(); 
  let conn = null;

  try {
    const userId = req.params.userId;
    // Validate userId is a number
    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: 'INVALID_USER_ID',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Get database connection
    conn = await poolInstance.getConnection();
    
    // Query to get specific user profile
    const [profiles] = await conn.query(`
      SELECT 
        h.FIRSTNAME,
        h.LASTNAME,
        h.DOB,
        CASE 
            WHEN h.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN') 
            THEN CONCAT('O-', REPLACE(h.AFPSN, 'O-', ''))
            ELSE h.AFPSN
        END AS afpsn,
        h.PENRANK AS penrank,
        h.TYPE,
        h.CTRLNR,
        h.MOBILENR,
        p.type as pensioner_type,
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
      JOIN test_table h ON p.hero_ndx = h.NDX
      WHERE u.id = ? AND u.status IN ('ACT', 'UNV' , 'TAG', 'DEL')
    `, [userId]);

    if (profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        code: 'PROFILE_NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const profile = profiles[0];
    
    const processingTime = Date.now() - startTime;

    // Format the response
    const profileResponse = {
      success: true,
      FIRSTNAME: profile.FIRSTNAME,
      TYPE: profile.TYPE,
      DOB: profile.DOB,
      LASTNAME: profile.LASTNAME,
      AFPSN: profile.AFPSN,
      BOS: profile.bos,
      EMAIL: profile.email,
      MOBILENR: profile.MOBILENR,
      CTRLNR: profile.CTRLNR,
      email: profile.email,
      status: profile.status,
      status_updated_at: profile.status_updated_at,
      profile_picture: profile.profile_picture,
      pensioner_type: profile.pensioner_type,
      ...(profile.pensioner_type === 'B' && {
        beneficiary_info: {
          b_type: profile.b_type,
          principal_firstname: profile.principal_firstname,
          principal_lastname: profile.principal_lastname
        }
      }),
      meta: {
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString()
      }
    };

    res.json(profileResponse);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PROFILE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve user profile",
      code: 'PROFILE_ERROR',
      processingTime: `${Date.now() - startTime}ms`
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

router.put('/profile/:userId/picture', async (req, res) => {
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
        code: 'INVALID_USER_ID',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (!profile_picture || typeof profile_picture !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Valid profile picture URL is required",
        code: 'INVALID_URL',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    conn = await poolInstance.getConnection();

    // Verify user exists
    const [users] = await conn.query(
      "SELECT id FROM users_tbl WHERE id = ? AND status IN ('ACT', 'UNV','TAG', 'DEL')",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: 'USER_NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Update user profile with new picture URL
    await conn.query(
      'UPDATE users_tbl SET profile_picture = ? WHERE id = ?',
      [profile_picture, userId]
    );

    const processingTime = Date.now() - startTime;

    console.log(`✅ Profile picture updated for user ${userId}: ${profile_picture}`);

    res.json({
      success: true,
      data: {
        profile_picture: profile_picture
      },
      message: 'Profile picture updated successfully',
      meta: {
        processingTime: `${processingTime}ms`,
        updated: new Date().toISOString()
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PROFILE PICTURE UPDATE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to update profile picture",
      code: 'UPDATE_ERROR',
      processingTime: `${processingTime}ms`
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
router.get('/submissions', async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool(); 
  let conn = null; 

  try {
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Get database connection
    conn = await poolInstance.getConnection();
    
    // This gets submissions for the most recent userr
    const [submissions] = await conn.query(`
      SELECT 
        fs.id,
        fs.form_type_id,
        fs.status,
        fs.submitted_at,
        fs.latitude,
        fs.longitude
      FROM form_submission fs
      JOIN users_tbl u ON fs.user_id = u.id
      WHERE u.status IN ('ACT', 'UNV', 'TAG', 'DEL')
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
        retrieved: new Date().toISOString()
      }
    };

    res.json(submissionsResponse);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== FORM SUBMISSIONS ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve form submissions",
      code: 'SUBMISSIONS_ERROR',
      processingTime: `${Date.now() - startTime}ms`
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

router.get('/submissions/:userId', async (req, res) => {
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
        code: 'INVALID_USER_ID',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    conn = await poolInstance.getConnection();
    
    // Query for specific user's submissions
    const [submissions] = await conn.query(`
      SELECT 
        fs.id,
        fs.form_type_id,
        fs.status,
        fs.submitted_at,
        fs.reviewed_at,
        fs.admin_notes,
        fs.latitude,
        fs.longitude
      FROM form_submission fs
      WHERE fs.user_id = ?
      AND fs.status IN ('p', 'a', 'd')
      ORDER BY fs.submitted_at DESC
    `, [userId]);

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      data: submissions,
      meta: {
        userId: parseInt(userId),
        count: submissions.length,
        processingTime: `${processingTime}ms`,
        retrieved: new Date().toISOString()
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== USER SUBMISSIONS ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to retrieve user submissions",
      code: 'USER_SUBMISSIONS_ERROR',
      processingTime: `${Date.now() - startTime}ms`
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
router.get('/form-types', async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        1: "Updating",
        2: "Restoration", 
        3: "Resumption",
        4: "Transfer of Pension",
        5: "Declaration of Legal Beneficiary"
      },
      message: "Form type ID mapping. Adjust these IDs based on your form_types table."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to retrieve form types"
    });
  }
});

// Update user's push token
router.put('/push-token/:userId', async (req, res) => {
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
        code: 'INVALID_USER_ID',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (!push_token || typeof push_token !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Valid push token is required",
        code: 'INVALID_TOKEN',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    conn = await poolInstance.getConnection();

    // Verify user exists
    const [users] = await conn.query(
      "SELECT id FROM users_tbl WHERE id = ? AND status IN ('ACT', 'UNV', 'TAG', 'DEL')",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        code: 'USER_NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Update user's push token
    await conn.query(
      'UPDATE users_tbl SET push_token = ? WHERE id = ?',
      [push_token, userId]
    );

    const processingTime = Date.now() - startTime;

    console.log(`✅ Push token updated for user ${userId}`);

    res.json({
      success: true,
      message: 'Push token saved successfully',
      meta: {
        processingTime: `${processingTime}ms`,
        updated: new Date().toISOString()
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PUSH TOKEN UPDATE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to save push token",
      code: 'UPDATE_ERROR',
      processingTime: `${processingTime}ms`
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
router.delete('/push-token/:userId', async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool();
  let conn = null;

  try {
    const userId = req.params.userId;

    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID provided",
        code: 'INVALID_USER_ID',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    conn = await poolInstance.getConnection();

    await conn.query(
      'UPDATE users_tbl SET push_token = NULL WHERE id = ?',
      [userId]
    );

    const processingTime = Date.now() - startTime;

    console.log(`✅ Push token removed for user ${userId}`);

    res.json({
      success: true,
      message: 'Push token removed successfully',
      meta: {
        processingTime: `${processingTime}ms`,
        updated: new Date().toISOString()
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("=== PUSH TOKEN DELETE ERROR ===");
    console.error("Error details:", error);

    res.status(500).json({
      success: false,
      error: "Failed to remove push token",
      code: 'DELETE_ERROR',
      processingTime: `${processingTime}ms`
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