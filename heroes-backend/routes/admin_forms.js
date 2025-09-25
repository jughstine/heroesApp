const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');
const { authenticateAdminToken } = require('./admin'); 

const SORT_COLUMN_MAP = {
  'id': 'fs.id',
  'submitted_at': 'fs.submitted_at',
  'status': 'fs.status',
  'user_email': 'u.email',
  'form_type_name': 'ft.name'
};
router.use(authenticateAdminToken);

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
        fs.longitude,
        fs.latitude,
        fs.location as location_status,
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
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10)); // Cap at 100
    const offset = (pageNum - 1) * limitNum;
    
    // Build WHERE clause based on filters
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

    // Safe sorting with column mapping
    const sortColumn = SORT_COLUMN_MAP[sort_by] || SORT_COLUMN_MAP['submitted_at'];
    const sortOrder = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN test_table t ON u.pensioner_ndx = t.NDX
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
        t.SUFFIX        
        
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN test_table t ON u.pensioner_ndx = t.NDX
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

// GET specific form details for admin
router.get('/:form_id', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;

    // Validate form_id is a number
    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid form ID' 
      });
    }

    const formId = parseInt(form_id);

    // Get form submission details with user and location info
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
        u.created_at as user_created_at
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN test_table t ON u.pensioner_ndx = t.NDX
      WHERE fs.id = ?
    `, [formId]);

    if (submissionRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Form submission not found' 
      });
    }

    // Get form requirements
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

// PUT - Update form status (admin only)
router.put('/:form_id/status', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;
    const { status, admin_notes } = req.body;

    // Validate form_id
    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({ success: false, error: 'Invalid form ID' });
    }

    // Get admin ID from JWT token (set by authenticateAdminToken middleware)
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

      // Set admin ID for any database triggers
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

// GET dashboard statistics
router.get('/analytics/dashboard-stats', async (req, res) => {
  try {
    const pool = getPool();

    // Use Promise.all for concurrent queries (better performance)
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

// GET forms by status
router.get('/status/:status', async (req, res) => {
  try {
    const pool = getPool();
    const { status } = req.params;

    // Validate status
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
        t.SUFFIX         
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      LEFT JOIN test_table t ON u.pensioner_ndx = t.NDX
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

// GET forms by location status  
router.get('/location/:location_status', async (req, res) => {
  try {
    const pool = getPool();
    const { location_status } = req.params;

    // Validate location status
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

// POST - Add admin notes to a form
router.post('/:form_id/notes', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;
    const { notes } = req.body;

    // Validate form_id
    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid form ID'
      });
    }
    const formId = parseInt(form_id);

    // Get admin ID from JWT token
    const adminId = req.admin.adminId;

    // Validate notes
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

    // Check if form exists
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
      // Update form with admin notes
      await pool.execute(
        'UPDATE form_submission SET admin_notes = ?, reviewed_at = NOW() WHERE id = ?',
        [notes.trim(), formId]
      );

      // Insert into history_logs
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

// DELETE - Delete a form submission (admin only)
router.delete('/:form_id', async (req, res) => {
  try {
    const pool = getPool();
    const { form_id } = req.params;

    // Validate form_id
    if (!form_id || isNaN(parseInt(form_id))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid form ID'
      });
    }

    const formId = parseInt(form_id);

    // Use transaction for data consistency
    await pool.execute('START TRANSACTION');

    try {
      // First delete related requirements
      await pool.execute('DELETE FROM form_requirements WHERE form_id = ?', [formId]);
      
      // Then delete the form submission
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