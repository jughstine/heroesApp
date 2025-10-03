const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');
const { authenticateAdminToken, requireSuperAdmin } = require('./admin'); 

const SORT_COLUMN_MAP = {
  'id': 'fs.id',
  'submitted_at': 'fs.submitted_at',
  'status': 'fs.status',
  'user_email': 'u.email',
  'form_type_name': 'ft.name'
};
router.use(authenticateAdminToken);

// ==================== HISTORY LOGS ROUTES ====================

// GET history logs statistics
router.get('/history-logs/stats', async (req, res) => {
  try {
    const pool = getPool();

    const [stats] = await pool.execute(`
      SELECT 
        COUNT(*) as totalLogs,
        COUNT(CASE WHEN status = 'p' THEN 1 END) as pendingActions,
        COUNT(CASE WHEN status = 'a' THEN 1 END) as approvedActions,
        COUNT(CASE WHEN status = 'd' THEN 1 END) as deniedActions,
        COUNT(CASE WHEN status = 'n' THEN 1 END) as noteActions,
        COUNT(CASE WHEN action_date >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 END) as recentActions,
        COUNT(CASE WHEN action_date >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 END) as weekActions
      FROM history_logs
    `);

    // Get most active admins
    const [activeAdmins] = await pool.execute(`
      SELECT 
        a.id,
        a.name,
        a.email,
        COUNT(hl.id) as action_count
      FROM history_logs hl
      JOIN admins_tbl a ON hl.action_by = a.id
      GROUP BY a.id, a.name, a.email
      ORDER BY action_count DESC
      LIMIT 5
    `);

    // Get recent activity trend (last 7 days)
    const [trend] = await pool.execute(`
      SELECT 
        DATE(action_date) as date,
        COUNT(*) as count,
        COUNT(CASE WHEN status = 'a' THEN 1 END) as approved,
        COUNT(CASE WHEN status = 'd' THEN 1 END) as denied,
        COUNT(CASE WHEN status = 'n' THEN 1 END) as notes
      FROM history_logs
      WHERE action_date >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(action_date)
      ORDER BY date DESC
    `);

    res.json({
      success: true,
      stats: {
        ...stats[0],
        activeAdmins: activeAdmins,
        weeklyTrend: trend
      }
    });

  } catch (error) {
    console.error('Error fetching history log stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch history log statistics' 
    });
  }
});

// GET history logs for a specific form
router.get('/history-logs/form/:form_id', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;

    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid form ID' 
      });
    }

    const formId = parseInt(form_id);

    const [logs] = await pool.execute(`
      SELECT 
        hl.id,
        hl.form_submission_id,
        hl.action_by,
        hl.status,
        hl.remarks,
        hl.action_date,
        a.name as admin_name,
        a.email as admin_email,
        a.role as admin_role
      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      WHERE hl.form_submission_id = ?
      ORDER BY hl.action_date DESC
    `, [formId]);

    res.json({
      success: true,
      data: {
        form_id: formId,
        log_count: logs.length,
        logs: logs
      }
    });

  } catch (error) {
    console.error('Error fetching form history logs:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch form history logs' 
    });
  }
});

// GET history logs by a specific admin
router.get('/history-logs/admin/:admin_id', async (req, res) => {
  try {
    const pool = getPool();
    const { admin_id } = req.params;

    if (!admin_id || isNaN(parseInt(admin_id))) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid admin ID' 
      });
    }

    const adminId = parseInt(admin_id);

    const [logs] = await pool.execute(`
      SELECT 
        hl.id,
        hl.form_submission_id,
        hl.action_by,
        hl.status,
        hl.remarks,
        hl.action_date,
        ft.name as form_type_name,
        u.email as user_email,
        fs.status as current_form_status
      FROM history_logs hl
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      WHERE hl.action_by = ?
      ORDER BY hl.action_date DESC
    `, [adminId]);

    // Get admin info
    const [adminInfo] = await pool.execute(
      'SELECT id, name, email, role FROM admins_tbl WHERE id = ?',
      [adminId]
    );

    if (adminInfo.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Admin not found'
      });
    }

    res.json({
      success: true,
      data: {
        admin: adminInfo[0],
        log_count: logs.length,
        logs: logs
      }
    });

  } catch (error) {
    console.error('Error fetching admin history logs:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch admin history logs' 
    });
  }
});

// GET all history logs with pagination and filtering
router.get('/history-logs', async (req, res) => {
  try {
    const pool = getPool();
    const {
      page = 1,
      limit = 50,
      status,
      search,
      form_id,
      admin_id,
      sort_by = 'action_date',
      sort_order = 'DESC'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    // Build WHERE clause
    let whereConditions = [];
    let queryParams = [];

    if (status && ['p', 'a', 'd', 'n'].includes(status)) {
      whereConditions.push('hl.status = ?');
      queryParams.push(status);
    }

    if (form_id && !isNaN(parseInt(form_id, 10))) {
      whereConditions.push('hl.form_submission_id = ?');
      queryParams.push(parseInt(form_id, 10));
    }

    if (admin_id && !isNaN(parseInt(admin_id, 10))) {
      whereConditions.push('hl.action_by = ?');
      queryParams.push(parseInt(admin_id, 10));
    }

    if (search && search.trim()) {
      whereConditions.push(`(
        hl.remarks LIKE ? OR 
        a.name LIKE ? OR 
        a.email LIKE ? OR 
        CAST(hl.id AS CHAR) LIKE ? OR
        CAST(hl.form_submission_id AS CHAR) LIKE ?
      )`);
      const searchParam = `%${search.trim()}%`;
      queryParams.push(searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Safe sorting
    const sortColumns = {
      'action_date': 'hl.action_date',
      'id': 'hl.id',
      'form_id': 'hl.form_submission_id',
      'status': 'hl.status'
    };
    const sortColumn = sortColumns[sort_by] || sortColumns['action_date'];
    const sortOrderSafe = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      ${whereClause}
    `;

    const [countResult] = await pool.execute(countQuery, queryParams);
    const totalCount = countResult[0].total;

    // Get paginated data - USE DIRECT INTERPOLATION FOR LIMIT/OFFSET
    // This is safe because we've sanitized these to be integers above
    const dataQuery = `
      SELECT 
        hl.id,
        hl.form_submission_id,
        hl.action_by,
        hl.status,
        hl.remarks,
        hl.action_date,
        a.name as admin_name,
        a.email as admin_email,
        a.role as admin_role,
        ft.name as form_type_name,
        u.email as user_email,
        fs.status as current_form_status,
        t.FIRSTNAME as pensioner_firstname,
        t.LASTNAME as pensioner_lastname
      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrderSafe}
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    // Pass only the WHERE clause parameters, not limit/offset
    const [rows] = await pool.execute(dataQuery, queryParams);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: rows,
      pagination: {
        current_page: pageNum,
        total_pages: totalPages,
        total_count: totalCount,
        per_page: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1
      }
    });

  } catch (error) {
    console.error('Error fetching history logs:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch history logs' 
    });
  }
});

// GET specific history log details
router.get('/history-logs/:log_id', async (req, res) => {
  try {
    const pool = getPool();
    const { log_id } = req.params;

    if (!log_id || isNaN(parseInt(log_id))) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid log ID' 
      });
    }

    const logId = parseInt(log_id);

    const [logs] = await pool.execute(`
      SELECT 
        hl.id,
        hl.form_submission_id,
        hl.action_by,
        hl.status,
        hl.remarks,
        hl.action_date,
        a.name as admin_name,
        a.email as admin_email,
        a.role as admin_role,
        ft.name as form_type_name,
        u.email as user_email,
        fs.status as current_form_status,
        fs.submitted_at,
        t.FIRSTNAME as pensioner_firstname,
        t.LASTNAME as pensioner_lastname,
        t.AFPSN
      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      WHERE hl.id = ?
    `, [logId]);

    if (logs.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'History log not found'
      });
    }

    res.json({
      success: true,
      data: logs[0]
    });

  } catch (error) {
    console.error('Error fetching history log details:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch history log details' 
    });
  }
});

// DELETE - Delete a history log (Super Admin only)
router.delete('/history-logs/:log_id', requireSuperAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const { log_id } = req.params;

    if (!log_id || isNaN(parseInt(log_id))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid log ID'
      });
    }

    const logId = parseInt(log_id);

    // Check if log exists
    const [logExists] = await pool.execute(
      'SELECT id FROM history_logs WHERE id = ?',
      [logId]
    );

    if (logExists.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'History log not found'
      });
    }

    // Delete the log
    await pool.execute('DELETE FROM history_logs WHERE id = ?', [logId]);

    console.log(`History log ${logId} deleted by admin ${req.admin.adminId} (${req.admin.email})`);

    res.json({
      success: true,
      message: 'History log deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting history log:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete history log' 
    });
  }
});

// ==================== FORM SUBMISSION ROUTES ====================

router.get('/', async (req, res) => {
  try {
    const pool = getPool();
    
    const [rows] = await pool.execute(`
      SELECT 
        fs.id,
        fs.user_id,
        fs.form_type_id,
        fs.status,
        fs.submitted_at,
        fs.reviewed_at,
        fs.longitude,
        fs.latitude,
        fs.location as location_status,
        ft.name as form_type_name,
        u.email as user_email,
        u.pensioner_ndx,
        t.NDX as test_table_ndx,
        t.FIRSTNAME,
        t.LASTNAME,
        t.MIDDLENAME,    
        t.SUFFIX,
        t.AFPSN,
        t.DOB,       
        t.TYPE,         
        p.type,          
        p.b_type         
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      ORDER BY fs.submitted_at DESC
      LIMIT 10
    `);

    res.json({ 
      success: true, 
      data: rows,
      count: rows.length 
    });

  } catch (error) {
    console.error('Error fetching admin forms:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch form submissions' 
    });
  }
});

router.get('/paginated', async (req, res) => {
  try {
    const pool = getPool();
    const {
      page = 1,
      limit = 10,
      status,
      location_status,
      search,
      sort_by = 'submitted_at',
      sort_order = 'DESC'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));
    const offset = (pageNum - 1) * limitNum;
    
    let whereConditions = [];
    let queryParams = [];

    if (status && ['p', 'a', 'd'].includes(status)) {
      whereConditions.push('fs.status = ?');
      queryParams.push(status);
    }

    if (location_status && ['loc', 'abr'].includes(location_status)) {
      whereConditions.push('fs.location = ?');
      queryParams.push(location_status);
    }

    if (search && search.trim()) {
      whereConditions.push(`(
        u.email LIKE ? OR 
        t.FIRSTNAME LIKE ? OR 
        t.LASTNAME LIKE ? OR 
        ft.name LIKE ? OR 
        CAST(fs.id AS CHAR) LIKE ?
      )`);
      const searchParam = `%${search.trim()}%`;
      queryParams.push(searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const sortColumn = SORT_COLUMN_MAP[sort_by] || SORT_COLUMN_MAP['submitted_at'];
    const sortOrder = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

    const countQuery = `
      SELECT COUNT(*) as total
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      ${whereClause}
    `;

    const [countResult] = await pool.execute(countQuery, queryParams);
    const totalCount = countResult[0].total;

    const dataQuery = `
      SELECT 
        fs.id,
        fs.user_id,
        fs.form_type_id,
        fs.status,
        fs.submitted_at,
        fs.longitude,
        fs.latitude,
        fs.location as location_status,
        ft.name as form_type_name,
        u.email as user_email,
        t.FIRSTNAME,
        t.LASTNAME,
        t.MIDDLENAME,    
        t.SUFFIX,
        t.AFPSN,
        t.TYPE,         
        t.CTRLNR,
        t.DOB,         
        p.type,      
        p.b_type     
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    queryParams.push(limitNum, offset);
    const [rows] = await pool.execute(dataQuery, queryParams);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: rows,
      pagination: {
        current_page: pageNum,
        total_pages: totalPages,
        total_count: totalCount,
        per_page: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1
      }
    });

  } catch (error) {
    console.error('Error fetching paginated admin forms:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch paginated form submissions' 
    });
  }
});

router.get('/export/bulk', async (req, res) => {
  try {
    const pool = getPool();
    const { status, location_status, form_type } = req.query;

    let whereConditions = ["(fs.status = 'a' OR fs.status = 'd')"];
    let queryParams = [];

    if (status && ['a', 'd'].includes(status)) {
      whereConditions = [`fs.status = ?`];
      queryParams.push(status);
    }

    if (location_status && ['loc', 'abr'].includes(location_status)) {
      whereConditions.push('fs.location = ?');
      queryParams.push(location_status);
    }

    if (form_type) {
      whereConditions.push('ft.name = ?');
      queryParams.push(form_type);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const [forms] = await pool.execute(`
      SELECT 
        fs.id,
        fs.reviewed_at,
        fs.submitted_at,
        fs.longitude,
        fs.latitude,
        ft.name as form_type_name,
        t.FIRSTNAME,
        t.LASTNAME,
        t.AFPSN,
        t.DOB,
        t.TYPE,
        p.b_type
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      ${whereClause}
      ORDER BY fs.submitted_at DESC
    `, queryParams);

    const formIds = forms.map(f => f.id);
    if (formIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const placeholders = formIds.map(() => '?').join(',');
    const [requirements] = await pool.execute(`
      SELECT form_id, requirement_type, value
      FROM form_requirements
      WHERE form_id IN (${placeholders})
        AND requirement_type IN ('home_address', 'mobile_number')
    `, formIds);

    const requirementMap = {};
    requirements.forEach(req => {
      if (!requirementMap[req.form_id]) {
        requirementMap[req.form_id] = {};
      }
      requirementMap[req.form_id][req.requirement_type] = req.value;
    });

    const exportData = forms.map(form => ({
      ...form,
      home_address: requirementMap[form.id]?.home_address || '',
      mobilenr: requirementMap[form.id]?.mobile_number || ''
    }));

    res.json({ success: true, data: exportData });

  } catch (error) {
    console.error('Error fetching bulk export:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch export data' 
    });
  }
});

router.get('/analytics/dashboard-stats', async (req, res) => {
  try {
    const pool = getPool();

    const [
      [overallStats],
      [recentStats], 
      formTypeStats,
      trendStats
    ] = await Promise.all([
      pool.execute(`
        SELECT 
          COUNT(*) as total_submissions,
          COUNT(CASE WHEN status = 'p' THEN 1 END) as pending_count,
          COUNT(CASE WHEN status = 'a' THEN 1 END) as approved_count,
          COUNT(CASE WHEN status = 'd' THEN 1 END) as denied_count,
          COUNT(CASE WHEN location = 'loc' THEN 1 END) as local_count,
          COUNT(CASE WHEN location = 'abr' THEN 1 END) as abroad_count
        FROM form_submission
      `),
      pool.execute(`
        SELECT COUNT(*) as recent_submissions
        FROM form_submission
        WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `),
      pool.execute(`
        SELECT 
          ft.name as form_type,
          COUNT(*) as count
        FROM form_submission fs
        JOIN form_type ft ON fs.form_type_id = ft.id
        GROUP BY ft.id, ft.name
        ORDER BY count DESC
      `),
      pool.execute(`
        SELECT 
          DATE(submitted_at) as date,
          COUNT(*) as count
        FROM form_submission
        WHERE submitted_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY DATE(submitted_at)
        ORDER BY date DESC
      `)
    ]);

    res.json({
      success: true,
      data: {
        overall: overallStats[0],
        recent: recentStats[0],
        by_form_type: formTypeStats[0],
        trend: trendStats[0]
      }
    });

  } catch (error) {
    console.error('Error fetching dashboard statistics:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard statistics' 
    });
  }
});

router.get('/status/:status', async (req, res) => {
  try {
    const pool = getPool();
    const { status } = req.params;

    if (!['p', 'a', 'd'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be p (pending), a (approved), or d (denied)'
      });
    }

    const [rows] = await pool.execute(`
      SELECT 
        fs.*,
        ft.name as form_type_name,
        u.email as user_email,
        t.FIRSTNAME,    
        t.LASTNAME,      
        t.MIDDLENAME,    
        t.SUFFIX,
        t.AFPSN,
        t.DOB,
        t.TYPE,         
        p.type,          
        p.b_type         
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX      
      WHERE fs.status = ?
      ORDER BY fs.submitted_at DESC
    `, [status]);

    const statusNames = {
      'p': 'pending',
      'a': 'approved', 
      'd': 'denied'
    };

    res.json({
      success: true,
      data: {
        status: statusNames[status],
        count: rows.length,
        submissions: rows
      }
    });

  } catch (error) {
    console.error('Error fetching forms by status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch forms by status' 
    });
  }
});

router.get('/location/:location_status', async (req, res) => {
  try {
    const pool = getPool();
    const { location_status } = req.params;

    if (!['loc', 'abr'].includes(location_status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid location_status. Must be "loc" (local) or "abr" (abroad)'
      });
    }

    const [rows] = await pool.execute(`
      SELECT 
        fs.*,
        ft.name as form_type_name,
        u.email as user_email,
        t.FIRSTNAME,     
        t.LASTNAME,      
        t.MIDDLENAME,    
        t.SUFFIX         
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN test_table t ON u.pensioner_ndx = t.NDX
      WHERE fs.location = ?
      ORDER BY fs.submitted_at DESC
    `, [location_status]);

    const locationNames = {
      'loc': 'local',
      'abr': 'abroad'
    };

    res.json({
      success: true,
      data: {
        location_status: location_status,
        location_name: locationNames[location_status],
        count: rows.length,
        submissions: rows
      }
    });

  } catch (error) {
    console.error('Error fetching forms by location status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch forms by location status' 
    });
  }
});

router.get('/:form_id', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;

    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid form ID' 
      });
    }

    const formId = parseInt(form_id);

    const [submissionRows] = await pool.execute(`
      SELECT 
        fs.*,
        fs.location as location_status,
        ft.name as form_type_name,
        u.email as user_email,
        t.FIRSTNAME,
        t.LASTNAME,
        t.MIDDLENAME,    
        t.SUFFIX,
        t.AFPSN,
        t.DOB, 
        t.TYPE,         
        p.type,      
        p.b_type,     
        u.created_at as user_created_at
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX
      WHERE fs.id = ?
    `, [formId]);

    if (submissionRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Form submission not found' 
      });
    }

    const [requirementRows] = await pool.execute(
      'SELECT * FROM form_requirements WHERE form_id = ? ORDER BY applies_to_location, requirement_type',
      [formId]
    );

    const formData = {
      ...submissionRows[0],
      requirements: requirementRows,
      location: {
        longitude: submissionRows[0].longitude,
        latitude: submissionRows[0].latitude,
        status: submissionRows[0].location
      }
    };

    res.json({ 
      success: true, 
      data: formData 
    });

  } catch (error) {
    console.error('Error fetching admin form details:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch form details' 
    });
  }
});

router.put('/:form_id/status', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;
    const { status, admin_notes } = req.body;

    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({ success: false, error: 'Invalid form ID' });
    }

    const adminId = req.admin.adminId;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        error: 'Admin authentication required'
      });
    }

    const formId = parseInt(form_id);
    const validStatuses = ['p', 'a', 'd'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be p (pending), a (approved), or d (denied)'
      });
    }

    if (admin_notes && admin_notes.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Admin notes cannot exceed 1000 characters'
      });
    }

    const [existingForm] = await pool.execute(
      'SELECT id, status FROM form_submission WHERE id = ?',
      [formId]
    );

    if (existingForm.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    await pool.query('START TRANSACTION');

    try {
      const updateQuery = admin_notes !== undefined
        ? 'UPDATE form_submission SET status = ?, admin_notes = ?, reviewed_at = NOW() WHERE id = ?'
        : 'UPDATE form_submission SET status = ?, reviewed_at = NOW() WHERE id = ?';

      const updateParams = admin_notes !== undefined
        ? [status, admin_notes, formId]
        : [status, formId];

      await pool.execute('SET @current_admin_id = ?', [adminId]);
      await pool.execute(updateQuery, updateParams);

      await pool.execute('COMMIT');

      console.log(`Form ${formId} status updated to ${status} by admin ${adminId} (${req.admin.email})`);

      res.json({ 
        success: true, 
        message: 'Form status updated successfully',
        updated_by: {
          admin_id: adminId,
          admin_email: req.admin.email,
          admin_name: req.admin.name
        }
      });
    } catch (transactionError) {
      await pool.execute('ROLLBACK');
      throw transactionError;
    }
  } catch (error) {
    console.error('Error updating form status:', error);
    res.status(500).json({ success: false, error: 'Failed to update form status' });
  }
});

router.post('/:form_id/notes', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;
    const { notes } = req.body;

    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid form ID'
      });
    }
    const formId = parseInt(form_id);

    const adminId = req.admin.adminId;

    if (!notes || typeof notes !== 'string' || notes.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Notes are required and must be non-empty'
      });
    }

    if (notes.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Notes cannot exceed 1000 characters'
      });
    }

    const [existingForm] = await pool.execute(
      'SELECT id FROM form_submission WHERE id = ?',
      [formId]
    );

    if (existingForm.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Form submission not found' 
      });
    }

    await pool.query('START TRANSACTION');

    try {
      await pool.execute(
        'UPDATE form_submission SET admin_notes = ?, reviewed_at = NOW() WHERE id = ?',
        [notes.trim(), formId]
      );

      await pool.execute(
        `INSERT INTO history_logs 
          (form_submission_id, action_by, status, remarks, action_date)
         VALUES (?, ?, ?, ?, NOW())`,
        [formId, adminId, 'n', `NOTE: ${notes.trim()}`] 
      );

      await pool.execute('COMMIT');

      console.log(`Admin notes added to form ${formId} by admin ${adminId} (${req.admin.email})`);

      res.json({ 
        success: true, 
        message: 'Admin notes added and logged successfully',
        added_by: {
          admin_id: adminId,
          admin_email: req.admin.email,
          admin_name: req.admin.name
        }
      });
    } catch (transactionError) {
      await pool.execute('ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('Error adding admin notes:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to add admin notes' 
    });
  }
});

router.delete('/:form_id', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;

    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid form ID'
      });
    }

    const formId = parseInt(form_id);

    await pool.execute('START TRANSACTION');

    try {
      await pool.execute('DELETE FROM form_requirements WHERE form_id = ?', [formId]);
      
      const [result] = await pool.execute('DELETE FROM form_submission WHERE id = ?', [formId]);

      if (result.affectedRows === 0) {
        await pool.execute('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Form submission not found'
        });
      }

      await pool.execute('COMMIT');

      res.json({
        success: true,
        message: 'Form submission deleted successfully'
      });

    } catch (transactionError) {
      await pool.execute('ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('Error deleting form submission:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete form submission'
    });
  }
});

module.exports = router;