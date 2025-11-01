const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const router = express.Router();
const db = require('../config/database');
const { 
  sendStatusChangeNotification 
} = require('../services/pushNotificationService');

const getPool = () => {
  if (typeof db.getPool === 'function') {
    return db.getPool();
  } else if (typeof db.pool === 'function') {
    return db.pool();
  } else if (db.pool && typeof db.pool.query === 'function') {
    return db.pool;
  }
  console.error('❌ Could not find pool in database module');
  return null;
};

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

    // Find admin in admins_tbl
    const query = `
      SELECT id, email, password_hash, name, mobile_number, role, created_at, last_login_at
      FROM admins_tbl 
      WHERE email = ? 
      LIMIT 1
    `;

    const results = await executeQuery(query, [email.trim().toLowerCase()]);

    if (!results || results.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    const admin = results[0];

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, admin.password_hash);

    if (!isPasswordValid) {
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
      id: admin.id, // Add this for compatibility
      email: admin.email,
      name: admin.name,
      mobileNumber: admin.mobile_number,
      role: admin.role,
      loginAt: new Date().toISOString(),
      type: 'admin'
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
      data: admins,
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

// ==================== NEW PERMISSION ROUTES ====================

// Get all navigation permissions
router.get('/nav-permissions', authenticateAdminToken, async (req, res) => {
  try {
    const query = 'SELECT id, name, path, description FROM nav_permissions ORDER BY name';
    const permissions = await executeQuery(query);
    
    res.json({
      success: true,
      data: permissions
    });
  } catch (error) {
    console.error('Get nav permissions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch navigation permissions'
    });
  }
});

// Get all form types
router.get('/form-types', authenticateAdminToken, async (req, res) => {
  try {
    const query = 'SELECT id, name FROM form_type ORDER BY name';
    const formTypes = await executeQuery(query);
    
    res.json({
      success: true,
      data: formTypes
    });
  } catch (error) {
    console.error('Get form types error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch form types'
    });
  }
});

// Get current admin's permissions
router.get('/my-permissions', authenticateAdminToken, async (req, res) => {
  try {
    const adminId = req.admin.id || req.admin.adminId;
    const role = req.admin.role;

    // Super admins get all permissions
    if (role === 'S_ADMIN') {
      const navPerms = await executeQuery(
        'SELECT id, name, path, description FROM nav_permissions'
      );
      
      const formTypes = await executeQuery('SELECT id, name FROM form_type');
      
      const formPerms = formTypes.map(ft => ({
        formTypeId: ft.id,
        formTypeName: ft.name,
        canView: true,
        canCreate: true,
        canEdit: true,
        canDelete: true
      }));

      return res.json({
        success: true,
        data: {
          navPermissions: navPerms,
          formPermissions: formPerms
        }
      });
    }

    // Get regular admin permissions
    const navPerms = await executeQuery(`
      SELECT np.id, np.name, np.path, np.description
      FROM nav_permissions np
      INNER JOIN admin_nav_access ana ON np.id = ana.nav_permission_id
      WHERE ana.admin_id = ?
    `, [adminId]);

    const formPerms = await executeQuery(`
      SELECT 
        afa.form_type_id as formTypeId,
        ft.name as formTypeName,
        afa.can_view as canView,
        afa.can_create as canCreate,
        afa.can_edit as canEdit,
        afa.can_delete as canDelete
      FROM admin_form_access afa
      INNER JOIN form_type ft ON afa.form_type_id = ft.id
      WHERE afa.admin_id = ?
    `, [adminId]);

    res.json({
      success: true,
      data: {
        navPermissions: navPerms,
        formPermissions: formPerms
      }
    });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch permissions'
    });
  }
});

// Create new admin with permissions (Super Admin only)
router.post('/create-admin', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  let connection;
  try {
    const { email, password, name, mobileNumber, role, navPermissions, formPermissions } = req.body;

    // Validate input
    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and name are required'
      });
    }

    connection = await getDbConnection();
    await connection.beginTransaction();

    // Check if admin already exists
    const [existingAdmin] = await connection.execute(
      'SELECT id FROM admins_tbl WHERE email = ?',
      [email.trim().toLowerCase()]
    );

    if (existingAdmin && existingAdmin.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        error: 'Admin with this email already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Insert new admin
    const [adminResult] = await connection.execute(
      `INSERT INTO admins_tbl (email, password_hash, name, mobile_number, role, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        email.trim().toLowerCase(),
        hashedPassword,
        name.trim(),
        mobileNumber || null,
        role || 'ADMIN'
      ]
    );

    const newAdminId = adminResult.insertId;

    // Insert navigation permissions
    if (navPermissions && navPermissions.length > 0) {
      const navValues = navPermissions.map(navId => `(${newAdminId}, ${navId})`).join(',');
      await connection.execute(
        `INSERT INTO admin_nav_access (admin_id, nav_permission_id) VALUES ${navValues}`
      );
    }

    // Insert form permissions
    if (formPermissions && formPermissions.length > 0) {
      const formValues = formPermissions.map(fp => 
        `(${newAdminId}, ${fp.formTypeId}, ${fp.canView ? 1 : 0}, ${fp.canCreate ? 1 : 0}, ${fp.canEdit ? 1 : 0}, ${fp.canDelete ? 1 : 0})`
      ).join(',');
      
      await connection.execute(
        `INSERT INTO admin_form_access 
         (admin_id, form_type_id, can_view, can_create, can_edit, can_delete) 
         VALUES ${formValues}`
      );
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      data: {
        id: newAdminId,
        email: email.trim().toLowerCase(),
        name: name.trim(),
        mobileNumber: mobileNumber || null,
        role: role || 'ADMIN'
      }
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
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
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Get admin details with permissions
router.get('/admin/:id', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const adminId = req.params.id;

    // Get admin basic info
    const admins = await executeQuery(
      `SELECT id, email, name, mobile_number, role, created_at, last_login_at 
       FROM admins_tbl WHERE id = ?`,
      [adminId]
    );

    if (!admins || admins.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Admin not found' 
      });
    }

    const admin = admins[0];

    // Get navigation permissions
    const navPerms = await executeQuery(
      `SELECT nav_permission_id FROM admin_nav_access WHERE admin_id = ?`,
      [adminId]
    );

    // Get form permissions
    const formPerms = await executeQuery(
      `SELECT form_type_id, can_view, can_create, can_edit, can_delete 
       FROM admin_form_access WHERE admin_id = ?`,
      [adminId]
    );

    res.json({
      success: true,
      data: {
        ...admin,
        navPermissions: navPerms.map(p => p.nav_permission_id),
        formPermissions: formPerms
      }
    });

  } catch (error) {
    console.error('Get admin error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch admin details' 
    });
  }
});

// Update admin permissions
router.put('/admin/:id/permissions', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  let connection;
  try {
    const adminId = req.params.id;
    const { navPermissions, formPermissions } = req.body;

    connection = await getDbConnection();
    await connection.beginTransaction();

    // Delete existing permissions
    await connection.execute('DELETE FROM admin_nav_access WHERE admin_id = ?', [adminId]);
    await connection.execute('DELETE FROM admin_form_access WHERE admin_id = ?', [adminId]);

    // Insert new navigation permissions
    if (navPermissions && navPermissions.length > 0) {
      const navValues = navPermissions.map(navId => `(${adminId}, ${navId})`).join(',');
      await connection.execute(
        `INSERT INTO admin_nav_access (admin_id, nav_permission_id) VALUES ${navValues}`
      );
    }

    // Insert new form permissions
    if (formPermissions && formPermissions.length > 0) {
      const formValues = formPermissions.map(fp => 
        `(${adminId}, ${fp.formTypeId}, ${fp.canView ? 1 : 0}, ${fp.canCreate ? 1 : 0}, ${fp.canEdit ? 1 : 0}, ${fp.canDelete ? 1 : 0})`
      ).join(',');
      
      await connection.execute(
        `INSERT INTO admin_form_access 
         (admin_id, form_type_id, can_view, can_create, can_edit, can_delete) 
         VALUES ${formValues}`
      );
    }

    await connection.commit();

    res.json({ 
      success: true, 
      message: 'Permissions updated successfully'
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Update permissions error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update permissions' 
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

// Delete admin
router.delete('/admin/:id', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const adminId = req.params.id;
    
    // Prevent deleting yourself
    if (parseInt(adminId) === (req.admin.id || req.admin.adminId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete your own account' 
      });
    }

    // Delete admin (cascade will handle permissions)
    await executeQuery('DELETE FROM admins_tbl WHERE id = ?', [adminId]);

    res.json({ 
      success: true, 
      message: 'Admin deleted successfully' 
    });

  } catch (error) {
    console.error('Delete admin error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete admin' 
    });
  }
});

// Get admin statistics (Super Admin only)
router.get('/stats', authenticateAdminToken, requireSuperAdmin, async (req, res) => {
  try {
    const queries = [
      'SELECT COUNT(*) as totalAdmins FROM admins_tbl',
      'SELECT COUNT(*) as activeAdmins FROM admins_tbl WHERE last_login_at IS NOT NULL',
      `SELECT COUNT(*) as superAdmins FROM admins_tbl WHERE role = 'S_ADMIN'`,
      `SELECT COUNT(*) as regularAdmins FROM admins_tbl WHERE role = 'ADMIN'`
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

// Admin logout (optional - mainly for logging)
router.post('/logout', authenticateAdminToken, (req, res) => {
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
      id: req.admin.adminId || req.admin.id,
      email: req.admin.email,
      name: req.admin.name,
      mobileNumber: req.admin.mobileNumber,
      role: req.admin.role,
      loginAt: req.admin.loginAt
    }
  });
});

router.get('/admins/same-role', authenticateAdminToken, async (req, res) => {
  try {
    const currentUserRole = req.admin.role;
    const currentUserId = req.admin.adminId || req.admin.id;

    if (!currentUserRole) {
      return res.status(400).json({
        success: false,
        error: 'User role not found',
        code: 'MISSING_ROLE'
      });
    }

    let query;
    let params;

    if (currentUserRole === 'S_ADMIN' || currentUserRole === 'CARES') {
      query = `
        SELECT id, email, name, mobile_number as mobileNumber, role, created_at as createdAt
        FROM admins_tbl 
        WHERE id != ?
        ORDER BY role ASC, name ASC
      `;
      params = [currentUserId];
    } else {
      query = `
        SELECT id, email, name, mobile_number as mobileNumber, role, created_at as createdAt
        FROM admins_tbl 
        WHERE (role = ? OR role = 'CARES') AND id != ?
        ORDER BY role ASC, name ASC
      `;
      params = [currentUserRole, currentUserId];
    }

    const results = await executeQuery(query, params);

    res.json({
      success: true,
      data: results || [],
      meta: {
        count: (results || []).length,
        current_user_role: currentUserRole,
        current_user_id: currentUserId,
        is_super_admin: currentUserRole === 'S_ADMIN',
        can_assign_to_all: currentUserRole === 'S_ADMIN' || currentUserRole === 'CARES'
      }
    });

  } catch (error) {
    console.error('Error fetching same-role admins:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admins',
      code: 'SERVER_ERROR'
    });
  }
});

// Update user status (Admin access required)
router.put('/users/:userId/status', authenticateAdminToken, async (req, res) => {
  let conn = null;
  
  try {
    const { userId } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['ACT', 'TAG', 'DEL', 'FOR_PAYROLL', 'AFR', 'AFB', 'AFB', 'UNV'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be one of: ACT, TAG, DEL, FOR_PAYROLL, AFR, UNV'
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();

    // Get current user status and push token BEFORE updating
    const [currentUser] = await conn.execute(
      'SELECT id, status, push_token FROM users_tbl WHERE id = ?',
      [userId]
    );

    if (currentUser.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = currentUser[0];
    const oldStatus = user.status;
    
    // Don't send notification if status hasn't actually changed
    if (oldStatus === status) {
      return res.json({
        success: true,
        message: 'Status unchanged',
        data: {
          userId: parseInt(userId),
          status: status,
          changed: false
        }
      });
    }

    // Update user status
    const [updateResult] = await conn.execute(
      'UPDATE users_tbl SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, userId]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to update user status'
      });
    }

    // Initialize notification result
    let notificationResult = {
      sent: false,
      reason: null,
      error: null
    };

    if (user.push_token) {
      try {        
        // Send FCM notification with correct arguments
        const result = await sendStatusChangeNotification(
          conn,              // Pass the database connection
          user.id,           // userId
          oldStatus,         // oldStatus
          status,            // newStatus
          user.FIRSTNAME,    // firstName
          user.LASTNAME      // lastName
        );

        if (result.success) {
          notificationResult.sent = true;
        } else {
          notificationResult.error = result.error;
          
          // If token is invalid, remove it from database
          if (result.shouldRemoveToken) {
            await conn.execute(
              'UPDATE users_tbl SET push_token = NULL WHERE id = ?',
              [userId]
            );
            notificationResult.reason = 'Invalid token removed';
          }
        }
      } catch (notifError) {
        console.error('❌ Error sending status notification:', notifError);
        notificationResult.error = notifError.message;
      }
    } else {
      notificationResult.reason = 'No push token';
    }

    res.json({
      success: true,
      message: 'User status updated successfully',
      data: {
        userId: parseInt(userId),
        userName: `${user.FIRSTNAME} ${user.LASTNAME}`,
        oldStatus: oldStatus,
        newStatus: status,
        changed: true,
        updatedAt: new Date().toISOString(),
        notification: notificationResult
      }
    });

  } catch (error) {
    console.error('❌ Update user status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user status'
    });
  } finally {
    if (conn) conn.release();
  }
});

router.post("/users/:userId/transfer-to-alpha", authenticateAdminToken, async (req, res) => {
    const startTime = Date.now();
    let connection;

    try {
        const { userId } = req.params;

        // First, get the pensioner info and verify they're in test_res_table
        const pensionerInfo = await executeQuery(`
            SELECT 
                p.id as pensioner_id,
                p.hero_ndx,
                p.source_table,
                p.type,
                p.bos,
                p.b_type,
                p.principal_firstname,
                p.principal_lastname
            FROM users_tbl u
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
            WHERE u.id = ?
            LIMIT 1
        `, [userId]);

        if (pensionerInfo.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Pensioner record not found",
                code: 'PENSIONER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const pensioner = pensionerInfo[0];

        // Check if already in test_table
        if (pensioner.source_table === 'test_table') {
            return res.status(400).json({
                success: false,
                error: "User is already in Alpha List (test_table)",
                code: 'ALREADY_IN_ALPHA',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Check if in test_res_table
        if (pensioner.source_table !== 'test_res_table') {
            return res.status(400).json({
                success: false,
                error: "User is not in Resumption List (test_res_table)",
                code: 'INVALID_SOURCE_TABLE',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Get the hero data from test_res_table
        const heroData = await executeQuery(`
            SELECT 
                LASTNAME,
                FIRSTNAME,
                MIDDLENAME,
                SUFFIX,
                DOB,
                AFPSN,
                ACRANK,
                PENRANK,
                TYPE,
                CTRLNR,
                MOBILENR
            FROM test_res_table
            WHERE NDX = ?
            LIMIT 1
        `, [pensioner.hero_ndx]);

        if (heroData.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Hero data not found in test_res_table",
                code: 'HERO_DATA_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const hero = heroData[0];

        // Get a connection for transaction
        connection = await getDbConnection();
        await connection.beginTransaction();

        try {
            // Insert into test_table (NDX will auto-increment)
            const [insertResult] = await connection.execute(`
                INSERT INTO test_table (
                    LASTNAME,
                    FIRSTNAME,
                    MIDDLENAME,
                    SUFFIX,
                    DOB,
                    AFPSN,
                    ACRANK,
                    PENRANK,
                    TYPE,
                    CTRLNR,
                    MOBILENR
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                hero.LASTNAME,
                hero.FIRSTNAME,
                hero.MIDDLENAME,
                hero.SUFFIX,
                hero.DOB,
                hero.AFPSN,
                hero.ACRANK,
                hero.PENRANK,
                hero.TYPE,
                hero.CTRLNR,
                hero.MOBILENR
            ]);

            const newHeroNdx = insertResult.insertId;

            // Update pensioners_tbl with new hero_ndx and source_table
            await connection.execute(`
                UPDATE pensioners_tbl
                SET hero_ndx = ?,
                    source_table = 'test_table'
                WHERE id = ?
            `, [newHeroNdx, pensioner.pensioner_id]);

            // Delete from test_res_table to complete the transfer
            await connection.execute(`
                DELETE FROM test_res_table
                WHERE NDX = ?
            `, [pensioner.hero_ndx]);

            // Commit transaction
            await connection.commit();

            const processingTime = Date.now() - startTime;

            res.json({
                success: true,
                message: "User successfully transferred to Alpha List",
                data: {
                    userId: parseInt(userId),
                    pensionerId: pensioner.pensioner_id,
                    oldHeroNdx: pensioner.hero_ndx,
                    newHeroNdx: newHeroNdx,
                    oldSourceTable: 'test_res_table',
                    newSourceTable: 'test_table'
                },
                meta: {
                    processingTime: `${processingTime}ms`,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (error) {
            // Rollback transaction on error
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        const processingTime = Date.now() - startTime;
        console.error("Transfer to Alpha error:", error);

        res.status(500).json({
            success: false,
            error: "Failed to transfer user to Alpha List",
            code: 'TRANSFER_ERROR',
            details: error.message,
            processingTime: `${processingTime}ms`
        });
    } finally {
        if (connection) {
            await connection.end();
        }
    }
});

router.delete("/users/:userId/delete-user", authenticateAdminToken, async (req, res) => {
    const startTime = Date.now();
    let connection;

    try {
        const { userId } = req.params;

        // First, get the pensioner info
        const userInfo = await executeQuery(`
            SELECT 
                u.id as user_id,
                u.pensioner_ndx,
                p.id as pensioner_id,
                p.hero_ndx,
                p.source_table,
                CONCAT(p.principal_firstname, ' ', p.principal_lastname) as name
            FROM users_tbl u
            LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
            WHERE u.id = ?
            LIMIT 1
        `, [userId]);

        if (userInfo.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                code: 'USER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const user = userInfo[0];

        // Get a connection for transaction
        connection = await getDbConnection();
        await connection.beginTransaction();

        try {
            // 1. Get all form submissions for this user
            const [formSubmissions] = await connection.execute(`
                SELECT id FROM form_submission WHERE user_id = ?
            `, [userId]);

            // 2. Delete history logs for each form submission
            if (formSubmissions.length > 0) {
                const formSubmissionIds = formSubmissions.map(fs => fs.id);
                const placeholders = formSubmissionIds.map(() => '?').join(',');
                
                await connection.execute(`
                    DELETE FROM history_logs 
                    WHERE form_submission_id IN (${placeholders})
                `, formSubmissionIds);

                console.log(`Deleted history logs for ${formSubmissionIds.length} form submissions`);
            }

            // 3. Delete form submissions
            const [deleteFormsResult] = await connection.execute(`
                DELETE FROM form_submission WHERE user_id = ?
            `, [userId]);

            console.log(`Deleted ${deleteFormsResult.affectedRows} form submissions`);

            // 4. Delete from users_tbl
            const [deleteUserResult] = await connection.execute(`
                DELETE FROM users_tbl WHERE id = ?
            `, [userId]);

            console.log(`Deleted user from users_tbl`);

            // 5. Delete from pensioners_tbl (if exists)
            let deletedPensioner = false;
            if (user.pensioner_id) {
                const [deletePensionerResult] = await connection.execute(`
                    DELETE FROM pensioners_tbl WHERE id = ?
                `, [user.pensioner_id]);
                
                deletedPensioner = deletePensionerResult.affectedRows > 0;
                console.log(`Deleted pensioner record: ${deletedPensioner}`);
            }

            // 6. Delete from source table (test_table or test_res_table) if hero_ndx exists
            let deletedFromSourceTable = false;
            if (user.hero_ndx && user.source_table) {
                const sourceTable = user.source_table === 'test_table' ? 'test_table' : 'test_res_table';
                
                try {
                    const [deleteHeroResult] = await connection.execute(`
                        DELETE FROM ${sourceTable} WHERE NDX = ?
                    `, [user.hero_ndx]);
                    
                    deletedFromSourceTable = deleteHeroResult.affectedRows > 0;
                    console.log(`Deleted from ${sourceTable}: ${deletedFromSourceTable}`);
                } catch (error) {
                    console.log(`Note: Could not delete from ${sourceTable}:`, error.message);
                    // Continue anyway - the hero record might not exist
                }
            }

            // Commit transaction
            await connection.commit();

            const processingTime = Date.now() - startTime;

            res.json({
                success: true,
                message: "User successfully deleted",
                data: {
                    userId: parseInt(userId),
                    pensionerId: user.pensioner_id,
                    heroNdx: user.hero_ndx,
                    sourceTable: user.source_table,
                    deletedRecords: {
                        historyLogs: formSubmissions.length > 0 ? 'deleted' : 'none',
                        formSubmissions: deleteFormsResult.affectedRows,
                        user: deleteUserResult.affectedRows,
                        pensioner: deletedPensioner,
                        heroRecord: deletedFromSourceTable
                    }
                },
                meta: {
                    processingTime: `${processingTime}ms`,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (error) {
            // Rollback transaction on error
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        const processingTime = Date.now() - startTime;
        console.error("Delete user error:", error);

        res.status(500).json({
            success: false,
            error: "Failed to delete user",
            code: 'DELETE_ERROR',
            details: error.message,
            processingTime: `${processingTime}ms`
        });
    } finally {
        if (connection) {
            await connection.end();
        }
    }
});

module.exports = {
  router,
  authenticateAdminToken,
  requireSuperAdmin
};