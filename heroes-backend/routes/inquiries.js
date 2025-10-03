const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');

// Database connection health check
const checkDatabaseHealth = async () => {
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};

// GET - Fetch all inquiry categories
router.get('/categories', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const [rows] = await conn.execute('SELECT * FROM inquiry_categories ORDER BY name ASC');
    
    res.json({ 
      success: true, 
      data: rows,
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching inquiry categories:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a new inquiry
router.post('/submit', async (req, res) => {
  const startTime = Date.now();
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

    const pool = getPool();
    conn = await pool.getConnection();

    const { name, email, mobilenr, category_id, message } = req.body;

    // Validate required fields (now includes mobilenr)
    if (!name || !email || !mobilenr || !category_id || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, email, mobilenr, category_id, and message are required',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format',
        code: 'INVALID_EMAIL',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate mobile number format (optional - add your own validation)
    if (mobilenr.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Mobile number cannot be empty',
        code: 'INVALID_MOBILE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate message length
    if (message.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Message exceeds maximum length of 1000 characters',
        code: 'MESSAGE_TOO_LONG',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Check if email already has a submission
    const [existingEmail] = await conn.execute(
      'SELECT id, created_at FROM inquiries WHERE email = ? LIMIT 1',
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'An inquiry with this email address has already been submitted',
        code: 'DUPLICATE_EMAIL',
        existing_inquiry_id: existingEmail[0].id,
        submitted_at: existingEmail[0].created_at,
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Check if mobile number already has a submission
    const [existingMobile] = await conn.execute(
      'SELECT id, created_at FROM inquiries WHERE mobilenr = ? LIMIT 1',
      [mobilenr]
    );

    if (existingMobile.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'An inquiry with this mobile number has already been submitted',
        code: 'DUPLICATE_MOBILE',
        existing_inquiry_id: existingMobile[0].id,
        submitted_at: existingMobile[0].created_at,
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Verify category exists
    const [categoryCheck] = await conn.execute(
      'SELECT id FROM inquiry_categories WHERE id = ?',
      [category_id]
    );

    if (categoryCheck.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid category_id',
        code: 'INVALID_CATEGORY',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Insert inquiry with default status 'pen' (pending)
    const [result] = await conn.execute(
      `INSERT INTO inquiries (name, email, mobilenr, category_id, message, status, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, 'pen', NOW(), NOW())`,
      [name, email, mobilenr, category_id, message]
    );

    const inquiryId = result.insertId;

    // Fetch the created inquiry with category details
    const [inquiry] = await conn.execute(`
      SELECT i.*, ic.name as category_name, ic.code as category_code
      FROM inquiries i
      JOIN inquiry_categories ic ON i.category_id = ic.id
      WHERE i.id = ?
    `, [inquiryId]);

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      message: 'Inquiry submitted successfully',
      data: {
        inquiry_id: inquiryId,
        name: inquiry[0].name,
        email: inquiry[0].email,
        mobilenr: inquiry[0].mobilenr,
        category: {
          id: inquiry[0].category_id,
          name: inquiry[0].category_name,
          code: inquiry[0].category_code
        },
        status: inquiry[0].status,
        created_at: inquiry[0].created_at
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting inquiry:', error);
    console.error('❌ Stack trace:', error.stack);

    let errorResponse = {
      success: false,
      error: "Inquiry submission failed due to server error",
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    };

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      errorResponse.error = "Database connection failed. Please try again later.";
      errorResponse.code = 'DB_CONNECTION_ERROR';
      return res.status(503).json(errorResponse);
    }

    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      errorResponse.error = "Database access denied. Please contact system administrator.";
      errorResponse.code = 'DB_ACCESS_ERROR';
      return res.status(503).json(errorResponse);
    }

    res.status(500).json(errorResponse);

  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});
// GET - Fetch all inquiries (with optional filtering)
router.get('/', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { status, category_id, assigned_to } = req.query;
    
    let query = `
      SELECT i.*, ic.name as category_name, ic.code as category_code
      FROM inquiries i
      JOIN inquiry_categories ic ON i.category_id = ic.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND i.status = ?';
      params.push(status);
    }

    if (category_id) {
      query += ' AND i.category_id = ?';
      params.push(category_id);
    }

    if (assigned_to) {
      query += ' AND i.assigned_to = ?';
      params.push(assigned_to);
    }

    query += ' ORDER BY i.created_at DESC';

    const [rows] = await conn.execute(query, params);
    
    res.json({ 
      success: true, 
      data: rows,
      meta: {
        count: rows.length,
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching inquiries:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET - Fetch specific inquiry by ID
router.get('/:inquiry_id', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { inquiry_id } = req.params;

    const [rows] = await conn.execute(`
      SELECT i.*, ic.name as category_name, ic.code as category_code, ic.description as category_description
      FROM inquiries i
      JOIN inquiry_categories ic ON i.category_id = ic.id
      WHERE i.id = ?
    `, [inquiry_id]);

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Inquiry not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    res.json({ 
      success: true, 
      data: rows[0],
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching inquiry:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET - Fetch inquiries by email
router.get('/email/:email', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { email } = req.params;

    const [rows] = await conn.execute(`
      SELECT i.*, ic.name as category_name, ic.code as category_code
      FROM inquiries i
      JOIN inquiry_categories ic ON i.category_id = ic.id
      WHERE i.email = ?
      ORDER BY i.created_at DESC
    `, [email]);

    res.json({ 
      success: true, 
      data: rows,
      meta: {
        count: rows.length,
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching inquiries by email:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET - Fetch inquiries by mobile number
router.get('/mobile/:mobilenr', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { mobilenr } = req.params;

    const [rows] = await conn.execute(`
      SELECT i.*, ic.name as category_name, ic.code as category_code
      FROM inquiries i
      JOIN inquiry_categories ic ON i.category_id = ic.id
      WHERE i.mobilenr = ?
      ORDER BY i.created_at DESC
    `, [mobilenr]);

    res.json({ 
      success: true, 
      data: rows,
      meta: {
        count: rows.length,
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching inquiries by mobile:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// PUT - Update inquiry status
router.put('/:inquiry_id/status', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { inquiry_id } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['pen', 'in_prog', 'res', 'clo']; // pending, in_progress, resolved, closed
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be pen (pending), in_prog (in progress), res (resolved), or clo (closed)',
        code: 'INVALID_STATUS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const [result] = await conn.execute(
      'UPDATE inquiries SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, inquiry_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Inquiry not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    res.json({ 
      success: true, 
      message: 'Inquiry status updated successfully',
      data: {
        inquiry_id: parseInt(inquiry_id),
        status: status
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error updating inquiry status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// PUT - Assign inquiry to user
router.put('/:inquiry_id/assign', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { inquiry_id } = req.params;
    const { assigned_to } = req.body;

    if (!assigned_to) {
      return res.status(400).json({
        success: false,
        error: 'assigned_to user ID is required',
        code: 'MISSING_ASSIGNED_TO',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Optionally verify the assigned_to user exists in users_tbl
    const [userCheck] = await conn.execute(
      'SELECT id FROM users_tbl WHERE id = ?',
      [assigned_to]
    );

    if (userCheck.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid assigned_to user ID',
        code: 'INVALID_USER',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const [result] = await conn.execute(
      'UPDATE inquiries SET assigned_to = ?, status = IF(status = "pen", "in_prog", status), updated_at = NOW() WHERE id = ?',
      [assigned_to, inquiry_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Inquiry not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    res.json({ 
      success: true, 
      message: 'Inquiry assigned successfully',
      data: {
        inquiry_id: parseInt(inquiry_id),
        assigned_to: assigned_to
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error assigning inquiry:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET - Analytics/Statistics for inquiries
router.get('/analytics/stats', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    // Get inquiry counts by status
    const [statusStats] = await conn.execute(`
      SELECT 
        status,
        COUNT(*) as count
      FROM inquiries
      GROUP BY status
    `);

    // Get inquiry counts by category
    const [categoryStats] = await conn.execute(`
      SELECT 
        ic.name as category_name,
        ic.code as category_code,
        COUNT(i.id) as count
      FROM inquiry_categories ic
      LEFT JOIN inquiries i ON ic.id = i.category_id
      GROUP BY ic.id, ic.name, ic.code
      ORDER BY count DESC
    `);

    // Get recent inquiries
    const [recentInquiries] = await conn.execute(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM inquiries
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    // Get assigned vs unassigned
    const [assignmentStats] = await conn.execute(`
      SELECT 
        COUNT(CASE WHEN assigned_to IS NOT NULL THEN 1 END) as assigned_count,
        COUNT(CASE WHEN assigned_to IS NULL THEN 1 END) as unassigned_count
      FROM inquiries
    `);

    res.json({
      success: true,
      data: {
        status_statistics: statusStats,
        category_statistics: categoryStats,
        recent_inquiries: recentInquiries,
        assignment_statistics: assignmentStats[0]
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching inquiry statistics:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// Health check endpoint
router.get("/health", async (req, res) => {
  const startTime = Date.now();
  
  try {
    const dbHealthy = await checkDatabaseHealth();
    const processingTime = Date.now() - startTime;
    
    res.json({
      success: true,
      status: 'healthy',
      services: {
        database: dbHealthy ? 'healthy' : 'degraded',
        inquiries: 'operational'
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

module.exports = router;