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

    console.log('New admin created by:', req.admin.email, 'New admin:', email);

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
      id: req.admin.adminId || req.admin.id,
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