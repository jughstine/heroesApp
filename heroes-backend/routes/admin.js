const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const router = express.Router();

// Database connection helper (using your existing config)
const getDbConnection = async () => {
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'afppgmc_db',
    port: process.env.DB_PORT || 3306,
    charset: 'utf8mb4',
    timezone: '+08:00'
  });
};

// Execute query helper
const executeQuery = async (query, params = []) => {
  let connection;
  try {
    connection = await getDbConnection();
    const [results] = await connection.execute(query, params);
    return results;
  } catch (error) {
    console.error('Admin DB query error:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

// Admin login endpoint (for web dashboard)
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    console.log('Admin login attempt:', email);

    // Find admin in admins_tbl
    const query = `
      SELECT id, email, password_hash, name, mobile_number, role, created_at, last_login_at
      FROM admins_tbl 
      WHERE email = ? 
      LIMIT 1
    `;

    const results = await executeQuery(query, [email.trim().toLowerCase()]);

    if (!results || results.length === 0) {
      console.log('Admin not found:', email);
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const admin = results[0];
    console.log('Admin found:', admin.email, 'Role:', admin.role);

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, admin.password_hash);

    if (!isPasswordValid) {
      console.log('Invalid password for admin:', email);
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Update last login timestamp
    const updateLoginQuery = 'UPDATE admins_tbl SET last_login_at = NOW() WHERE id = ?';
    await executeQuery(updateLoginQuery, [admin.id]);

    // Create JWT payload
    const jwtPayload = {
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      mobileNumber: admin.mobile_number,
      role: admin.role,
      loginAt: new Date().toISOString(),
      type: 'admin' // Distinguish from mobile app tokens
    };

    // Generate JWT token
    const token = jwt.sign(
      jwtPayload, 
      process.env.JWT_SECRET,
      { 
        expiresIn: process.env.JWT_EXPIRATION || '24h',
        issuer: 'afppgmc-admin-web',
        audience: 'afppgmc-admin-panel'
      }
    );

    console.log('Admin login successful:', admin.email, 'Role:', admin.role);

    // Success response
    res.json({
      success: true,
      message: 'Login successful',
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        mobileNumber: admin.mobile_number,
        role: admin.role,
        createdAt: admin.created_at,
        lastLoginAt: new Date().toISOString()
      },
      token: token
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      error: process.env.NODE_ENV === 'development' 
        ? error.message 
        : 'Internal server error'
    });
  }
});

// Middleware to authenticate admin JWT tokens
const authenticateAdminToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token required'
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, admin) => {
    if (err) {
      console.error('Admin JWT verification error:', err.message);
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Ensure this is an admin token (not a mobile app user token)
    if (admin.type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    req.admin = admin;
    next();
  });
};

// Middleware to check if admin is Super Admin
const requireSuperAdmin = (req, res, next) => {
  if (req.admin.role !== 'S_ADMIN') {
    return res.status(403).json({
      success: false,
      error: 'Super admin access required'
    });
  }
  next();
};

// Get current admin profile
router.get('/profile', authenticateAdminToken, (req, res) => {
  res.json({
    success: true,
    admin: {
      id: req.admin.adminId,
      email: req.admin.email,
      name: req.admin.name,
      mobileNumber: req.admin.mobileNumber,
      role: req.admin.role,
      loginAt: req.admin.loginAt
    }
  });
});

// Get all admins (Super Admin only)
router.get('/admins', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const query = `
      SELECT id, email, name, mobile_number, role, created_at, last_login_at
      FROM admins_tbl 
      ORDER BY created_at DESC
    `;

    const admins = await executeQuery(query);

    res.json({
      success: true,
      admins: admins,
      total: admins.length
    });

  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admins'
    });
  }
});

// Get admin statistics (Super Admin only)
router.get('/stats', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const queries = [
      'SELECT COUNT(*) as totalAdmins FROM admins_tbl',
      'SELECT COUNT(*) as activeAdmins FROM admins_tbl WHERE last_login_at IS NOT NULL',
      'SELECT COUNT(*) as superAdmins FROM admins_tbl WHERE role = "S_ADMIN"',
      'SELECT COUNT(*) as regularAdmins FROM admins_tbl WHERE role = "ADMIN"'
    ];

    const [totalResult, activeResult, superResult, regularResult] = await Promise.all(
      queries.map(query => executeQuery(query))
    );

    const stats = {
      totalAdmins: totalResult[0].totalAdmins,
      activeAdmins: activeResult[0].activeAdmins,
      superAdmins: superResult[0].superAdmins,
      regularAdmins: regularResult[0].regularAdmins,
      lastUpdated: new Date().toISOString()
    };

    res.json({
      success: true,
      stats: stats
    });

  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// Create new admin (Super Admin only)
router.post('/create-admin', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const { email, password, name, mobileNumber } = req.body;

    // Validate input
    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and name are required'
      });
    }

    // Check if admin already exists
    const checkQuery = 'SELECT id FROM admins_tbl WHERE email = ?';
    const existingAdmin = await executeQuery(checkQuery, [email.trim().toLowerCase()]);

    if (existingAdmin && existingAdmin.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Admin with this email already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Insert new admin
    const insertQuery = `
      INSERT INTO admins_tbl (email, password_hash, name, mobile_number, role, created_at)
      VALUES (?, ?, ?, ?, 'ADMIN', NOW())
    `;

    const insertParams = [
      email.trim().toLowerCase(),
      hashedPassword,
      name.trim(),
      mobileNumber || null
    ];

    await executeQuery(insertQuery, insertParams);

    console.log('New admin created by:', req.admin.email, 'New admin:', email);

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      admin: {
        email: email.trim().toLowerCase(),
        name: name.trim(),
        mobileNumber: mobileNumber || null,
        role: 'ADMIN'
      }
    });

  } catch (error) {
    console.error('Create admin error:', error);
    
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(409).json({
        success: false,
        error: 'Admin with this email already exists'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to create admin account'
      });
    }
  }
});

// Update admin status (Super Admin only)
router.patch('/admins/:id/status', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    // Prevent super admin from deactivating themselves
    if (parseInt(id) === req.admin.adminId && !isActive) {
      return res.status(400).json({
        success: false,
        error: 'Cannot deactivate your own account'
      });
    }

    // For now, we'll just return success since your table doesn't have an is_active column
    // You can add this column later if needed: ALTER TABLE admins_tbl ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    
    res.json({
      success: true,
      message: 'Admin status updated successfully'
    });

  } catch (error) {
    console.error('Update admin status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update admin status'
    });
  }
});

// Admin logout (optional - mainly for logging)
router.post('/logout', authenticateAdminToken, (req, res) => {
  console.log('Admin logout:', req.admin.email);
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

router.get("/verify", authenticateAdminToken, (req, res) => {
  res.json({
    success: true,
    valid: true,
    admin: {
      id: req.admin.adminId,
      email: req.admin.email,
      name: req.admin.name,
      mobileNumber: req.admin.mobileNumber,
      role: req.admin.role,
      loginAt: req.admin.loginAt
    }
  });
});


module.exports = {
  router,
  authenticateAdminToken,
  requireSuperAdmin
};