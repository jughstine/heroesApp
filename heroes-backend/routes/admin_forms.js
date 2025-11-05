const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');
const { authenticateAdminToken, requireSuperAdmin } = require('./admin'); 
const {
  sendFormApprovalNotification,
  sendFormDenialNotification,
  sendAdminNotesNotification
} = require('../services/pushNotificationService');
const multer = require('multer');
const { Client } = require('minio');

const SORT_COLUMN_MAP = {
  'id': 'fs.id',
  'submitted_at': 'fs.submitted_at',
  'status': 'fs.status',
  'user_email': 'u.email',
  'form_type_name': 'ft.name'
};

router.use(authenticateAdminToken);
const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for PDFs
  },
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed for resolution documents'), false);
    }
  }
});

const minioClient = new Client({
  endPoint: process.env.SPACES_ENDPOINT.replace('https://', ''),
  port: 443,
  useSSL: true,
  accessKey: process.env.SPACES_KEY,
  secretKey: process.env.SPACES_SECRET,
});

const RESTORATION_TABLES = [
  'rst_widow_requirements',
  'rst_bi_principal_requirements',
  'rst_bi_bene_requirements',
  'rst_re_entitle_requirements',
  'rst_principal_requirements'
];

const getRestorationTableForForm = async (pool, formId) => {
  const tableTypeMap = {
    'rst_widow_requirements': 'widow',
    'rst_bi_principal_requirements': 'bi_principal',
    'rst_bi_bene_requirements': 'bi_bene',
    'rst_re_entitle_requirements': 're_entitle',
    'rst_principal_requirements': 'principal'
  };

  for (const tableName of RESTORATION_TABLES) {
    try {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) as count FROM ${tableName} WHERE form_id = ?`,
        [formId]
      );
      
      if (rows[0].count > 0) {
        return {
          tableName,
          subtype: tableTypeMap[tableName]
        };
      }
    } catch (error) {
      console.error(`Error checking table ${tableName}:`, error);
    }
  }
  
  return {
    tableName: 'rst_principal_requirements',
    subtype: 'principal'
  };
};

const DLB_TYPES_TABLES = [
  'dlb_child_requirements',
  'dlb_parent_requirements',
  'dlb_sibling_requirements',
  'dlb_spouse_requirements'
];

const getDlbForForm = async (pool, formId) => {
  const tableTypeMap = {
    'dlb_child_requirements': 'child',
    'dlb_parent_requirements': 'parent',
    'dlb_sibling_requirements': 'sibling',
    'dlb_spouse_requirements': 'spouse'
  };

  for (const tableName of DLB_TYPES_TABLES) {
    try {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) as count FROM ${tableName} WHERE form_id = ?`,
        [formId]
      );
      
      if (rows[0].count > 0) {
        return {
          tableName,
          subtype: tableTypeMap[tableName]
        };
      }
    } catch (error) {
      console.error(`Error checking table ${tableName}:`, error);
    }
  }
  
  return {
    tableName: 'dlb_child_requirements',
    subtype: 'child'
  };
};

const getFormRequirements = async (pool, formId, formTypeId) => {
  
  if (formTypeId === 2) {
    const [requirements] = await pool.execute(
      'SELECT * FROM rsm_requirements WHERE form_id = ? ORDER BY requirement_type',
      [formId]
    );
    return { 
      requirements, 
      tableName: 'rsm_requirements',
    };
  } else if (formTypeId === 3) {
    const { tableName, subtype } = await getRestorationTableForForm(pool, formId);    
    const [requirements] = await pool.execute(
      `SELECT * FROM ${tableName} WHERE form_id = ? ORDER BY applies_to_location, requirement_type`,
      [formId]
    );
    return { 
      requirements, 
      tableName,
      rst_subtype: subtype
    };
  } else if (formTypeId === 4) {
    const [requirements] = await pool.execute(
      'SELECT * FROM top_requirements WHERE form_id = ? ORDER BY requirement_type',
      [formId]
    );
    return { 
      requirements, 
      tableName: 'top_requirements',
    };
  } else if (formTypeId === 1) {
    const { tableName, subtype } = await getDlbForForm(pool, formId);    
    const [requirements] = await pool.execute(
      `SELECT * FROM ${tableName} WHERE form_id = ? ORDER BY applies_to_location, requirement_type`,
      [formId]
    );
    return { 
      requirements, 
      tableName,
      dlb_subtype: subtype
    };
  } 
  
  else if (formTypeId === 5) {
    const [requirements] = await pool.execute(
      'SELECT * FROM upd_requirements WHERE form_id = ? ORDER BY applies_to_location, requirement_type',
      [formId]
    );
    return { 
      requirements, 
      tableName: 'upd_requirements',
      rst_subtype: null
    };
  } else {
    const [requirements] = await pool.execute(
      'SELECT * FROM upd_requirements WHERE form_id = ? ORDER BY applies_to_location, requirement_type',
      [formId]
    );
    return { 
      requirements, 
      tableName: 'upd_requirements',
      rst_subtype: null
    };
  }
};

// ==================== HISTORY LOGS ROUTES ====================

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
    `);

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
        u.profile_picture,
        u.status_updated_at,
        fs.status as current_form_status
      FROM history_logs hl
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      WHERE hl.action_by = ?
      ORDER BY hl.action_date DESC
    `, [adminId]);

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

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const offset = (pageNum - 1) * limitNum;

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

    const sortColumns = {
      'action_date': 'hl.action_date',
      'id': 'hl.id',
      'form_id': 'hl.form_submission_id',
      'status': 'hl.status'
    };
    const sortColumn = sortColumns[sort_by] || sortColumns['action_date'];
    const sortOrderSafe = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

    const countQuery = `
      SELECT COUNT(*) as total
      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      ${whereClause}
    `;

    const [countResult] = await pool.execute(countQuery, queryParams);
    const totalCount = countResult[0].total;

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
        u.profile_picture,
        u.status_updated_at,
        fs.status as current_form_status,
        p.source_table,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END as pensioner_firstname,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END as pensioner_lastname,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.AFPSN
          WHEN p.source_table = 'beneficiaries_table' THEN b.AFPSN
          ELSE t.AFPSN
        END as AFPSN,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END as PENRANK

      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id

      -- main joins for all possible source tables
      LEFT JOIN test_table t 
        ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr 
        ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b 
        ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'

      ${whereClause}
      ORDER BY ${sortColumn} ${sortOrderSafe}
      LIMIT ${limitNum} OFFSET ${offset}
    `;

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
        a.name AS admin_name,
        a.email AS admin_email,
        a.role AS admin_role,
        u.status_updated_at,
        u.email AS user_email,
        u.profile_picture,
        fs.status AS current_form_status,
        fs.submitted_at,
        ft.name AS form_type_name,
        p.source_table,
        
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END AS pensioner_firstname,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END AS pensioner_lastname,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.AFPSN
          WHEN p.source_table = 'beneficiaries_table' THEN b.AFPSN
          ELSE t.AFPSN
        END AS AFPSN,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END AS PENRANK

      FROM history_logs hl
      LEFT JOIN admins_tbl a ON hl.action_by = a.id
      LEFT JOIN form_submission fs ON hl.form_submission_id = fs.id
      LEFT JOIN form_type ft ON fs.form_type_id = ft.id
      LEFT JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t 
        ON p.hero_ndx = t.NDX 
        AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr 
        ON p.hero_ndx = tr.NDX 
        AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b 
        ON p.hero_ndx = b.NDX 
        AND p.source_table = 'beneficiaries_table'
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

    await pool.execute('DELETE FROM history_logs WHERE id = ?', [logId]);

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
        u.profile_picture,
        u.status_updated_at,
        u.pensioner_ndx,
        p.source_table,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.NDX
          WHEN p.source_table = 'beneficiaries_table' THEN b.NDX
          ELSE t.NDX
        END as test_table_ndx,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END as FIRSTNAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END as LASTNAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.MIDDLENAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.MIDDLENAME
          ELSE t.MIDDLENAME
        END as MIDDLENAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.SUFFIX
          WHEN p.source_table = 'beneficiaries_table' THEN b.SUFFIX
          ELSE t.SUFFIX
        END as SUFFIX,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN 
            CASE 
              WHEN tr.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO') 
              THEN CONCAT('O-', tr.AFPSN)
              ELSE tr.AFPSN
            END
          WHEN p.source_table = 'beneficiaries_table' THEN 
            CASE 
              WHEN b.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO') 
              THEN CONCAT('O-', b.AFPSN)
              ELSE b.AFPSN
            END
          ELSE 
            CASE 
              WHEN t.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO') 
              THEN CONCAT('O-', t.AFPSN)
              ELSE t.AFPSN
            END
        END as AFPSN,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.DOB
          WHEN p.source_table = 'beneficiaries_table' THEN b.DOB
          ELSE t.DOB
        END as DOB,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.TYPE
          WHEN p.source_table = 'beneficiaries_table' THEN b.TYPE
          ELSE t.TYPE
        END as TYPE,
        p.type as pensioner_type,
        p.b_type,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END as PENRANK
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
      ORDER BY fs.submitted_at DESC
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
    const limitNum = Math.max(1, parseInt(limit, 10) || 50);
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
        COALESCE(t.FIRSTNAME, tr.FIRSTNAME, b.FIRSTNAME) LIKE ? OR 
        COALESCE(t.LASTNAME, tr.LASTNAME, b.LASTNAME) LIKE ? OR 
        ft.name LIKE ? OR 
        CAST(fs.id AS CHAR) LIKE ?
      )`);
      const searchParam = `%${search.trim()}%`;
      queryParams.push(searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Optional: define sort columns to prevent SQL injection
    const SORT_COLUMN_MAP = {
      submitted_at: 'fs.submitted_at',
      reviewed_at: 'fs.reviewed_at',
      status: 'fs.status',
      form_type_name: 'ft.name'
    };

    const sortColumn = SORT_COLUMN_MAP[sort_by] || SORT_COLUMN_MAP['submitted_at'];
    const sortOrder = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

    // Count Query
    const countQuery = `
      SELECT COUNT(*) as total
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
      ${whereClause}
    `;

    const [countResult] = await pool.execute(countQuery, queryParams);
    const totalCount = countResult[0].total;

    // Data Query
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
        u.profile_picture,
        u.status_updated_at,
        p.source_table,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END as FIRSTNAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END as LASTNAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.MIDDLENAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.MIDDLENAME
          ELSE t.MIDDLENAME
        END as MIDDLENAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.SUFFIX
          WHEN p.source_table = 'beneficiaries_table' THEN b.SUFFIX
          ELSE t.SUFFIX
        END as SUFFIX,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN 
            CASE 
              WHEN tr.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO') 
              THEN CONCAT('O-', tr.AFPSN)
              ELSE tr.AFPSN
            END
          WHEN p.source_table = 'beneficiaries_table' THEN 
            CASE 
              WHEN b.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO') 
              THEN CONCAT('O-', b.AFPSN)
              ELSE b.AFPSN
            END
          ELSE 
            CASE 
              WHEN t.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO') 
              THEN CONCAT('O-', t.AFPSN)
              ELSE t.AFPSN
            END
        END as AFPSN,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.TYPE
          WHEN p.source_table = 'beneficiaries_table' THEN b.TYPE
          ELSE t.TYPE
        END as TYPE,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.CTRLNR
          WHEN p.source_table = 'beneficiaries_table' THEN b.CTRLNR
          ELSE t.CTRLNR
        END as CTRLNR,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.DOB
          WHEN p.source_table = 'beneficiaries_table' THEN b.DOB
          ELSE t.DOB
        END as DOB,
        p.type as pensioner_type,
        p.b_type,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END as PENRANK
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
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
        fs.form_type_id,
        fs.reviewed_at,
        fs.submitted_at,
        fs.longitude,
        fs.latitude,
        ft.name AS form_type_name,
        p.source_table,
        p.b_type,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END AS FIRSTNAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END AS LASTNAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN 
            CASE 
              WHEN tr.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','COL','BGEN','MGEN','LGEN','CDR','COMMO') 
              THEN CONCAT('O-', tr.AFPSN)
              ELSE tr.AFPSN
            END
          WHEN p.source_table = 'beneficiaries_table' THEN 
            CASE 
              WHEN b.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','COL','BGEN','MGEN','LGEN','CDR','COMMO') 
              THEN CONCAT('O-', b.AFPSN)
              ELSE b.AFPSN
            END
          ELSE 
            CASE 
              WHEN t.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','COL','BGEN','MGEN','LGEN','CDR','COMMO') 
              THEN CONCAT('O-', t.AFPSN)
              ELSE t.AFPSN
            END
        END AS AFPSN,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END AS PENRANK,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.DOB
          WHEN p.source_table = 'beneficiaries_table' THEN b.DOB
          ELSE t.DOB
        END AS DOB,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.TYPE
          WHEN p.source_table = 'beneficiaries_table' THEN b.TYPE
          ELSE t.TYPE
        END AS TYPE,

        CASE 
          WHEN p.bos = 'AR' THEN 'Philippine Army'
          WHEN p.bos = 'AF' THEN 'Philippine Air Force'
          WHEN p.bos = 'NV' THEN 'Philippine Navy'
          WHEN p.bos = 'PC' THEN 'Philippine Constabulary'
          ELSE p.bos
        END AS bos

      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t 
        ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr 
        ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b 
        ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
      ${whereClause}
      ORDER BY fs.submitted_at DESC
    `, queryParams);

    if (forms.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Separate forms by type
    const regularFormIds = forms.filter(f => f.form_type_id !== 2 && f.form_type_id !== 3).map(f => f.id);
    const resumptionFormIds = forms.filter(f => f.form_type_id === 2).map(f => f.id);
    const transferFormIds = forms.filter(f => f.form_type_id === 4).map(f => f.id);
    const restorationFormIds = forms.filter(f => f.form_type_id === 3).map(f => f.id);
    const dlbFormIds = forms.filter(f => f.form_type_id === 1).map(f => f.id);

    const requirementMap = {};

    // --- Get requirements for all types of forms ---
    if (regularFormIds.length > 0) {
      const placeholders = regularFormIds.map(() => '?').join(',');
      const [requirements] = await pool.execute(`
        SELECT form_id, requirement_type, value
        FROM upd_requirements
        WHERE form_id IN (${placeholders})
          AND requirement_type IN ('home_address', 'mobile_number')
      `, regularFormIds);

      requirements.forEach(req => {
        if (!requirementMap[req.form_id]) requirementMap[req.form_id] = {};
        requirementMap[req.form_id][req.requirement_type] = req.value;
      });
    }

    if (resumptionFormIds.length > 0) {
      const placeholders = resumptionFormIds.map(() => '?').join(',');
      const [rsmRequirements] = await pool.execute(`
        SELECT form_id, requirement_type, value
        FROM rsm_requirements
        WHERE form_id IN (${placeholders})
          AND requirement_type IN ('home_address', 'mobile_number')
      `, resumptionFormIds);

      rsmRequirements.forEach(req => {
        if (!requirementMap[req.form_id]) requirementMap[req.form_id] = {};
        requirementMap[req.form_id][req.requirement_type] = req.value;
      });
    }

    if (transferFormIds.length > 0) {
      const placeholders = transferFormIds.map(() => '?').join(',');
      const [topRequirements] = await pool.execute(`
        SELECT form_id, requirement_type, value
        FROM top_requirements
        WHERE form_id IN (${placeholders})
          AND requirement_type IN ('mobile_number')
      `, transferFormIds);

      topRequirements.forEach(req => {
        if (!requirementMap[req.form_id]) requirementMap[req.form_id] = {};
        requirementMap[req.form_id][req.requirement_type] = req.value;
      });
    }

    for (const formId of restorationFormIds) {
      const result = await getRestorationTableForForm(pool, formId);
      const tableName = result.tableName;
      try {
        const [type3Requirements] = await pool.execute(`
          SELECT form_id, requirement_type, value
          FROM ${tableName}
          WHERE form_id = ?
            AND requirement_type IN ('home_address', 'mobile_number')
        `, [formId]);
        type3Requirements.forEach(req => {
          if (!requirementMap[req.form_id]) requirementMap[req.form_id] = {};
          requirementMap[req.form_id][req.requirement_type] = req.value;
        });
      } catch (tableError) {
        console.error(`Error fetching requirements from ${tableName}:`, tableError);
      }
    }

    for (const formId of dlbFormIds) {
      const result = await getDlbForForm(pool, formId);
      const tableName = result.tableName;
      try {
        const [dlbRequirements] = await pool.execute(`
          SELECT form_id, requirement_type, value
          FROM ${tableName}
          WHERE form_id = ?
            AND requirement_type IN ('home_address', 'mobile_number')
        `, [formId]);
        dlbRequirements.forEach(req => {
          if (!requirementMap[req.form_id]) requirementMap[req.form_id] = {};
          requirementMap[req.form_id][req.requirement_type] = req.value;
        });
      } catch (tableError) {
        console.error(`Error fetching requirements from ${tableName}:`, tableError);
      }
    }

    // Combine form + requirement data
    const exportData = forms.map(form => ({
      ...form,
      home_address: requirementMap[form.id]?.home_address || '',
      mobilenr: requirementMap[form.id]?.mobile_number || '',
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
        error: 'Invalid status. Must be p (pending), a (approved), or d (denied)',
      });
    }

    const [rows] = await pool.execute(`
      SELECT 
        fs.*,
        ft.name AS form_type_name,
        u.email AS user_email,
        u.profile_picture,
        u.status_updated_at,
        p.source_table,
        p.type AS pensioner_type,
        p.b_type,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END AS FIRSTNAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END AS LASTNAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.MIDDLENAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.MIDDLENAME
          ELSE t.MIDDLENAME
        END AS MIDDLENAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.SUFFIX
          WHEN p.source_table = 'beneficiaries_table' THEN b.SUFFIX
          ELSE t.SUFFIX
        END AS SUFFIX,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN 
            CASE 
              WHEN tr.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','COL','BGEN','MGEN','LGEN','CDR','COMMO') 
              THEN CONCAT('O-', tr.AFPSN)
              ELSE tr.AFPSN
            END
          WHEN p.source_table = 'beneficiaries_table' THEN 
            CASE 
              WHEN b.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','COL','BGEN','MGEN','LGEN','CDR','COMMO') 
              THEN CONCAT('O-', b.AFPSN)
              ELSE b.AFPSN
            END
          ELSE 
            CASE 
              WHEN t.PENRANK IN ('2LT','1LT','CPT','MAJ','LTC','LTCOL','COL','BGEN','MGEN','LGEN','CDR','COMMO') 
              THEN CONCAT('O-', t.AFPSN)
              ELSE t.AFPSN
            END
        END AS AFPSN,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END AS PENRANK,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.DOB
          WHEN p.source_table = 'beneficiaries_table' THEN b.DOB
          ELSE t.DOB
        END AS DOB,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.TYPE
          WHEN p.source_table = 'beneficiaries_table' THEN b.TYPE
          ELSE t.TYPE
        END AS TYPE

      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t 
        ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr 
        ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b 
        ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
      WHERE fs.status = ?
      ORDER BY fs.submitted_at DESC
    `, [status]);

    const statusNames = {
      p: 'pending',
      a: 'approved',
      d: 'denied',
    };

    res.json({
      success: true,
      data: {
        status: statusNames[status],
        count: rows.length,
        submissions: rows,
      },
    });

  } catch (error) {
    console.error('Error fetching forms by status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch forms by status',
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
        u.profile_picture,
        u.status_updated_at,
        p.source_table,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END as FIRSTNAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END as LASTNAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.MIDDLENAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.MIDDLENAME
          ELSE t.MIDDLENAME
        END as MIDDLENAME,
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.SUFFIX
          WHEN p.source_table = 'beneficiaries_table' THEN b.SUFFIX
          ELSE t.SUFFIX
        END as SUFFIX
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
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
    
    // Validate form_id
    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({ success: false, error: 'Invalid form ID' });
    }

    const formId = parseInt(form_id);

    const [formBasicInfo] = await pool.execute(`
      SELECT 
        fs.id,
        fs.user_id,
        fs.form_type_id,
        p.source_table
      FROM form_submission fs
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      WHERE fs.id = ?
    `, [formId]);

    if (formBasicInfo.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    const sourceTable = formBasicInfo[0].source_table || 'test_table';

    if (!['test_table', 'test_res_table', 'beneficiaries_table'].includes(sourceTable)) {
      console.error(`Invalid source_table: ${sourceTable} for form ${formId}`);
      return res.status(500).json({ success: false, error: 'Invalid source table configuration' });
    }

    const [submissionRows] = await pool.execute(`
      SELECT 
        fs.*,
        fs.location AS location_status,
        ft.name AS form_type_name,
        u.email AS user_email,
        u.profile_picture,
        u.status_updated_at,
        u.created_at AS user_created_at,
        p.source_table,
        p.type AS pensioner_type,
        p.b_type,

        -- Name details
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.FIRSTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.FIRSTNAME
          ELSE t.FIRSTNAME
        END AS FIRSTNAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.LASTNAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.LASTNAME
          ELSE t.LASTNAME
        END AS LASTNAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.MIDDLENAME
          WHEN p.source_table = 'beneficiaries_table' THEN b.MIDDLENAME
          ELSE t.MIDDLENAME
        END AS MIDDLENAME,

        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.SUFFIX
          WHEN p.source_table = 'beneficiaries_table' THEN b.SUFFIX
          ELSE t.SUFFIX
        END AS SUFFIX,

        -- AFPSN (with officer prefix logic)
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.AFPSN
          WHEN p.source_table = 'beneficiaries_table' THEN b.AFPSN
          ELSE t.AFPSN
        END AS AFPSN,

        -- Rank
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.PENRANK
          WHEN p.source_table = 'beneficiaries_table' THEN b.PENRANK
          ELSE t.PENRANK
        END AS PENRANK,

        -- Date of birth
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.DOB
          WHEN p.source_table = 'beneficiaries_table' THEN b.DOB
          ELSE t.DOB
        END AS DOB,

        -- Type
        CASE 
          WHEN p.source_table = 'test_res_table' THEN tr.TYPE
          WHEN p.source_table = 'beneficiaries_table' THEN b.TYPE
          ELSE t.TYPE
        END AS TYPE

      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table t 
        ON p.hero_ndx = t.NDX AND (p.source_table = 'test_table' OR p.source_table IS NULL)
      LEFT JOIN test_res_table tr 
        ON p.hero_ndx = tr.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table b 
        ON p.hero_ndx = b.NDX AND p.source_table = 'beneficiaries_table'
      WHERE fs.id = ?
    `, [formId]);

    if (submissionRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    const submission = submissionRows[0];

    const formattedAFPSN =
      submission.PENRANK &&
      ['2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR', 'COMMO'].includes(submission.PENRANK)
        ? (submission.AFPSN?.startsWith('O-') ? submission.AFPSN : `O-${submission.AFPSN}`)
        : submission.AFPSN;

    const result = await getFormRequirements(pool, formId, submission.form_type_id);

    const formData = {
      ...submission,
      AFPSN: formattedAFPSN,
      type: submission.pensioner_type,
      requirements: result.requirements || [],
      requirement_table_used: result.tableName,
      rst_subtype: result.rst_subtype,
      dlb_subtype: result.dlb_subtype,
      source_table: sourceTable,
      location: {
        longitude: submission.longitude,
        latitude: submission.latitude,
        status: submission.location_status
      }
    };

    res.json({ success: true, data: formData });

  } catch (error) {
    console.error('Error fetching admin form details:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch form details',
      details: error.message
    });
  }
});

router.put('/:form_id/status', upload.single('resolution_pdf'), async (req, res) => {
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
      'SELECT id, status, form_type_id, user_id FROM form_submission WHERE id = ?',
      [formId]
    );

    if (existingForm.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    const formTypeId = existingForm[0].form_type_id;
    const userId = existingForm[0].user_id;

    // For DLB forms (form_type_id = 1), require PDF on approval
    if (formTypeId === 1 && status === 'a' && !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Resolution PDF is required for approving Declaration of Legal Beneficiary forms'
      });
    }

    // Declare these variables outside the transaction try block
    let resolutionFileUrl = null;
    let resolutionFileKey = null;

    await pool.query('START TRANSACTION');

    try {
      // Handle PDF upload for DLB forms on approval
      if (formTypeId === 1 && status === 'a' && req.file) {
        // Get user details for filename - Join through pensioners_tbl
        const [userDetails] = await pool.execute(
          `SELECT 
            COALESCE(b.FIRSTNAME, p.principal_firstname, 'User') as FIRSTNAME,
            COALESCE(b.LASTNAME, p.principal_lastname, 'Unknown') as LASTNAME
          FROM users_tbl u
          LEFT JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
          LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX
          WHERE u.id = ?`,
          [userId]
        );

        if (userDetails.length === 0) {
          throw new Error('User not found in users_tbl');
        }

        const user = userDetails[0];
        const lastName = user.LASTNAME || 'Unknown';
        const firstName = user.FIRSTNAME || 'User';
        const timestamp = Date.now();
        const fileName = `resolutions/${timestamp}-${lastName}_${firstName}_DLB_Resolution.pdf`;
        
        // Upload to DigitalOcean Spaces
        await minioClient.putObject(
          process.env.SPACES_BUCKET,
          fileName,
          req.file.buffer,
          req.file.size,
          {
            'Content-Type': 'application/pdf',
            'x-amz-acl': 'public-read',
            'x-amz-meta-original-name': `${lastName}_${firstName}_DLB_Resolution.pdf`,
            'x-amz-meta-upload-timestamp': timestamp.toString(),
            'x-amz-meta-form-id': formId.toString(),
            'x-amz-meta-user-id': userId.toString(),
            'x-amz-meta-uploaded-by': adminId.toString()
          }
        );

        resolutionFileUrl = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_REGION || 'sgp1'}.digitaloceanspaces.com/${fileName}`;
        resolutionFileKey = fileName;
      }

      let updateQuery = 'UPDATE form_submission SET status = ?, reviewed_at = NOW()';
      let updateParams = [status];

      if (admin_notes !== undefined) {
        updateQuery += ', admin_notes = ?';
        updateParams.push(admin_notes);
      }

      if (resolutionFileUrl) {
        updateQuery += ', resolution_file_url = ?, resolution_file_key = ?';
        updateParams.push(resolutionFileUrl, resolutionFileKey);
      }

      updateQuery += ' WHERE id = ?';
      updateParams.push(formId);

      await pool.execute('SET @current_admin_id = ?', [adminId]);
      await pool.execute(updateQuery, updateParams);

      if (formTypeId === 1 && status === 'a') {
        await pool.execute(
          'UPDATE users_tbl SET status = ?, approved_at = NOW() WHERE id = ?',
          ['AFB2', userId]
        );
      }

      // Conditional approval: If form type is 3 (Restoration) and status is approved
      if (formTypeId === 3 && status === 'a') {
        await pool.execute(
          'UPDATE users_tbl SET status = ?, approved_at = NOW(), status_updated_at = NOW() WHERE id = ?',
          ['ACT', userId]
        );
      }

      if (formTypeId === 2 && status === 'a') {
        await pool.execute(
          'UPDATE users_tbl SET status = ?, approved_at = NOW() WHERE id = ?',
          ['FOR_PAYROLL', userId]
        );
      }

      if (formTypeId === 4 && status === 'a') {
        await pool.execute(
          'UPDATE users_tbl SET status = ?, approved_at = NOW() WHERE id = ?',
          ['FOR_PAYROLL', userId]
        );
      }

      if (formTypeId === 5 && status === 'a') {
        const [updateFormData] = await pool.execute(
          `SELECT value 
          FROM upd_requirements 
          WHERE form_id = ? AND requirement_type = 'home_address'`,
          [formId]
        );

        const homeAddress = updateFormData[0]?.value;

        // Update status
        await pool.execute(
          'UPDATE users_tbl SET status = ?, status_updated_at = NOW() WHERE id = ?',
          ['ACT', userId]
        );

        // Update home address if found
        if (homeAddress) {
          await pool.execute(
            'UPDATE users_tbl SET home_address = ? WHERE id = ?',
            [homeAddress, userId]
          );
        }
      }

      // Delete requirements from appropriate table if status is denied
      if (status === 'd') {
        if (formTypeId === 2) {
          await pool.execute('DELETE FROM rsm_requirements WHERE form_id = ?', [formId]);
        } 
        else if (formTypeId === 3) {
          const result = await getRestorationTableForForm(pool, formId);
          const tableName = result.tableName;
          await pool.execute(`DELETE FROM ${tableName} WHERE form_id = ?`, [formId]);
        }
        else if (formTypeId === 1) {
          const result = await getDlbForForm(pool, formId);
          const tableName = result.tableName;
          await pool.execute(`DELETE FROM ${tableName} WHERE form_id = ?`, [formId]);
          
          // Delete resolution file from Spaces if exists
          const [formData] = await pool.execute(
            'SELECT resolution_file_key FROM form_submission WHERE id = ?',
            [formId]
          );
          if (formData[0]?.resolution_file_key) {
            try {
              await minioClient.removeObject(
                process.env.SPACES_BUCKET,
                formData[0].resolution_file_key
              );
              console.log('✅ Deleted resolution file:', formData[0].resolution_file_key);
            } catch (deleteErr) {
              console.error('⚠️ Error deleting resolution file (continuing anyway):', deleteErr.message);
            }
          }
        }
         else if (formTypeId === 5) {
          await pool.execute('DELETE FROM upd_requirements WHERE form_id = ?', [formId]);
        } else {
          await pool.execute('DELETE FROM upd_requirements WHERE form_id = ?', [formId]);
        }
      }

      await pool.execute('COMMIT');

      // Pass pool as first parameter to notification functions
      let notificationResult = { success: false };
      
      try {
        if (status === 'a') {
          notificationResult = await sendFormApprovalNotification(pool, userId, {
            form_id: formId,
            form_type_id: formTypeId
          });
        } else if (status === 'd') {
          notificationResult = await sendFormDenialNotification(pool, userId, {
            form_id: formId,
            form_type_id: formTypeId
          });
        }
      } catch (notifError) {
        console.error('⚠️ Notification failed but continuing:', notifError);
      }

      const response = { 
        success: true, 
        message: 'Form status updated successfully',
        requirements_deleted: status === 'd',
        form_type_id: formTypeId,
        notification_sent: notificationResult.success,
        notification_error: notificationResult.error || null,
        resolution_uploaded: !!resolutionFileUrl,
        resolution_file_url: resolutionFileUrl,
        resolution_file_key: resolutionFileKey,
        updated_by: {
          admin_id: adminId,
          admin_email: req.admin.email,
          admin_name: req.admin.name
        }
      };

      if (formTypeId === 3 && status === 'a') {
        response.user_status_updated = true;
        response.new_user_status = 'ACT';
      }

      res.json(response);
    } catch (transactionError) {
      await pool.execute('ROLLBACK');
      
      // Clean up uploaded file if transaction failed
      if (resolutionFileKey) {
        try {
          await minioClient.removeObject(
            process.env.SPACES_BUCKET,
            resolutionFileKey
          );
          console.log('🧹 Cleaned up file after transaction failure:', resolutionFileKey);
        } catch (cleanupErr) {
          console.error('⚠️ Error cleaning up file:', cleanupErr.message);
        }
      }
      
      throw transactionError;
    }
  } catch (error) {
    console.error('Error updating form status:', error);
    
    // Handle multer errors
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          success: false, 
          error: 'PDF file too large. Maximum size is 10MB.' 
        });
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update form status' 
    });
  }
});

// Admin notes route
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
      'SELECT id, user_id, form_type_id FROM form_submission WHERE id = ?',
      [formId]
    );

    if (existingForm.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Form submission not found' 
      });
    }

    const userId = existingForm[0].user_id;
    const formTypeId = existingForm[0].form_type_id;

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

      // Pass pool as first parameter
      let notificationResult = { success: false };
      
      try {
        notificationResult = await sendAdminNotesNotification(pool, userId, {
          form_id: formId,
          form_type_id: formTypeId
        });
      } catch (notifError) {
        console.error('⚠️ Admin note notification failed:', notifError);
      }

      res.json({ 
        success: true, 
        message: 'Admin notes added and logged successfully',
        notification_sent: notificationResult.success,
        notification_error: notificationResult.error || null,
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
      // Get form type to determine which requirements table to delete from
      const [formInfo] = await pool.execute(`
        SELECT form_type_id FROM form_submission WHERE id = ?
      `, [formId]);

      if (formInfo.length === 0) {
        await pool.execute('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Form submission not found'
        });
      }

      const formTypeId = formInfo[0].form_type_id;

      // Delete from appropriate requirements table
      if (formTypeId === 2) {
        // Resumption
        await pool.execute('DELETE FROM rsm_requirements WHERE form_id = ?', [formId]);
      } 
      else if (formTypeId === 3) {
        // Restoration
        const result = await getRestorationTableForForm(pool, formId);
        const tableName = result.tableName;
        await pool.execute(`DELETE FROM ${tableName} WHERE form_id = ?`, [formId]);
      } 
      else if (formTypeId === 1) {
        // Declaration of Legal Beneficiary - FIXED: Added await here
        const result = await getDlbForForm(pool, formId);
        const tableName = result.tableName;
        await pool.execute(`DELETE FROM ${tableName} WHERE form_id = ?`, [formId]);
      } 
      else {
        // Updating (default)
        await pool.execute('DELETE FROM upd_requirements WHERE form_id = ?', [formId]);
      }
      
      // Delete the form submission
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
        message: 'Form submission deleted successfully',
        form_type_id: formTypeId
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