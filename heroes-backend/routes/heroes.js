const express = require('express');
const { pool, getPool } = require('../config/database'); // ✅ Import both pool and getPool
const router = express.Router();

// Database connection health check
const checkDatabaseHealth = async () => {
  try {
    const poolInstance = getPool(); // ✅ Use consistent naming
    const conn = await poolInstance.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};

// User Profile endpoint
router.get('/profile', async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool(); // ✅ Use consistent naming
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
      WHERE u.status IN ('ACT', 'UNV')
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
    console.error("=== PROFILE ERROR ==="); // ✅ Fixed missing console.error
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
  const poolInstance = getPool(); // ✅ Add pool instance
  let conn = null; // ✅ Fixed declaration

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
        h.AFPSN,
        h.TYPE,
        h.CTRLNR,
        h.MOBILENR,
        p.type as pensioner_type,
        p.b_type,
        p.principal_firstname,
        p.principal_lastname,
        u.email,
        u.status,
        u.created_at
      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      JOIN test_table h ON p.hero_ndx = h.NDX
      WHERE u.id = ? AND u.status IN ('ACT', 'UNV')
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
      MOBILENR: profile.MOBILENR,
      CTRLNR: profile.CTRLNR,
      email: profile.email,
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

// Form submissions endpoint
router.get('/submissions', async (req, res) => {
  const startTime = Date.now();
  const poolInstance = getPool(); // ✅ Add pool instance
  let conn = null; // ✅ Fixed declaration

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
      WHERE u.status IN ('ACT', 'UNV')
      AND fs.status IN ('p', 'a') -- Only pending or approved submissions
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
  const poolInstance = getPool(); // ✅ Add pool instance
  let conn = null; // ✅ Fixed declaration

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
        fs.latitude,
        fs.longitude
      FROM form_submission fs
      WHERE fs.user_id = ?
      AND fs.status IN ('p', 'a') -- Only pending or approved
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

module.exports = router;