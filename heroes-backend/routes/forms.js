const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');

router.get('/types', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT * FROM form_type');
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching form types:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST - Submit a new form
router.post('/submit', async (req, res) => {
   const pool = getPool();
   const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata, 
      abroad_status 
    } = req.body;

    // Set form_type_id to 5
    const form_type_id = 5;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array'
      });
    }

    // Convert location values to proper types if they exist
    let finalLongitude = null;
    let finalLatitude = null;

    if (longitude !== null && longitude !== undefined && longitude !== '') {
      finalLongitude = Number(longitude);
      if (isNaN(finalLongitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value'
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value'
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180'
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90'
        });
      }
    }

    // Determine location status based on abroad_status
    const locationStatus = abroad_status ? 'abr' : 'loc';

    
    // Insert form submission with location data and location status
    const [submissionResult] = await connection.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, locationStatus, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion by querying the record
    const [insertedRecord] = await connection.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    // Insert form requirements with proper applies_to_location mapping
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      let applies_to_location = 'both'; 
      
      if (['passport', 'oath_of_allegiance', 'cert_of_naturalization'].includes(requirement_type)) {
        applies_to_location = 'abr';
      } 

      else if (['unified_id', 'photo_2x2', 'video_submission', 'home_address', 'crs5_reference'].includes(requirement_type)) {
        applies_to_location = abroad_status ? 'abr' : 'loc';
      }

      await connection.execute(
        `INSERT INTO form_requirements (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          formSubmissionId, 
          requirement_type, 
          value || null, 
          file_url || null, 
          file_key || null, 
          file_type || null,
          applies_to_location
        ]
      );

    }

    await connection.commit();

    const responseData = {
      success: true,
      message: 'Form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        location_status: locationStatus,
        abroad_status: abroad_status,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        }
      }
    };

    res.json(responseData);

  } catch (error) {
    await connection.rollback();
    console.error('❌ Error submitting form:', error);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
});

// GET user's form submissions with location data
router.get('/user/:user_id', async (req, res) => {
   const pool = getPool();
   const connection = await pool.getConnection();


  try {
    const { user_id } = req.params;

    const [rows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name,
             fs.longitude, fs.latitude, fs.location as location_status
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      WHERE fs.user_id = ?
      ORDER BY fs.submitted_at DESC
    `, [user_id]);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching user submissions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET specific form submission with requirements and location
router.get('/:form_id', async (req, res) => {
   const pool = getPool();
   const connection = await pool.getConnection();
  
  try {
    const { form_id } = req.params;

    // Get form submission details with location
    const [submissionRows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name, u.email as user_email,
             fs.longitude, fs.latitude, fs.location as location_status
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      WHERE fs.id = ?
    `, [form_id]);

    if (submissionRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    // Get form requirements with applies_to_location
    const [requirementRows] = await db.execute(
      'SELECT * FROM form_requirements WHERE form_id = ? ORDER BY applies_to_location, requirement_type',
      [form_id]
    );

    const formData = {
      ...submissionRows[0],
      requirements: requirementRows,
      location: {
        longitude: submissionRows[0].longitude,
        latitude: submissionRows[0].latitude,
        status: submissionRows[0].location_status
      }
    };

    res.json({ success: true, data: formData });
  } catch (error) {
    console.error('Error fetching form submission:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET forms by location status (local vs abroad)
router.get('/location/:location_status', async (req, res) => {
   const pool = getPool();
   const connection = await pool.getConnection();
  
  try {
    const { location_status } = req.params;

    // Validate location status
    if (!['loc', 'abr'].includes(location_status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid location_status. Must be "loc" (local) or "abr" (abroad)'
      });
    }

    const [rows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name,
             fs.longitude, fs.latitude, fs.location as location_status
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      WHERE fs.location = ?
      ORDER BY fs.submitted_at DESC
    `, [location_status]);

    res.json({
      success: true,
      data: {
        location_status: location_status,
        count: rows.length,
        submissions: rows
      }
    });
  } catch (error) {
    console.error('Error fetching forms by location status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET forms by location proximity 
router.get('/location/nearby', async (req, res) => {
   const pool = getPool();
   const connection = await pool.getConnection();
  
  try {
    const { longitude, latitude, radius = 10 } = req.query;

    if (!longitude || !latitude) {
      return res.status(400).json({
        success: false,
        error: 'longitude and latitude parameters are required'
      });
    }

    const lng = parseFloat(longitude);
    const lat = parseFloat(latitude);
    const radiusKm = parseFloat(radius);

    if (isNaN(lng) || isNaN(lat) || isNaN(radiusKm)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coordinate or radius values'
      });
    }

    // Using Haversine formula to calculate distance
    const [rows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name,
             fs.longitude, fs.latitude, fs.location as location_status,
             (
               6371 * acos(
                 cos(radians(?)) * cos(radians(fs.latitude)) *
                 cos(radians(fs.longitude) - radians(?)) +
                 sin(radians(?)) * sin(radians(fs.latitude))
               )
             ) AS distance_km
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      WHERE fs.longitude IS NOT NULL 
        AND fs.latitude IS NOT NULL
      HAVING distance_km <= ?
      ORDER BY distance_km ASC
      LIMIT 100
    `, [lat, lng, lat, radiusKm]);

    res.json({
      success: true,
      data: {
        center: { longitude: lng, latitude: lat },
        radius_km: radiusKm,
        results: rows
      }
    });
  } catch (error) {
    console.error('Error fetching nearby forms:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT - Update form submission status
router.put('/:form_id/status', async (req, res) => {
  try {
    const { form_id } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['p', 'a', 'd']; // pending, approved, denied
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be p (pending), a (approved), or d (denied)'
      });
    }

    const [result] = await db.execute(
      'UPDATE form_submission SET status = ? WHERE id = ?',
      [status, form_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    res.json({ success: true, message: 'Form status updated successfully' });
  } catch (error) {
    console.error('Error updating form status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET location statistics with abroad/local breakdown
router.get('/analytics/location-stats', async (req, res) => {
  try {
    // Get submission counts by location status
    const [locationStats] = await db.execute(`
      SELECT 
        location as location_status,
        COUNT(*) as total_submissions,
        COUNT(CASE WHEN status = 'a' THEN 1 END) as approved_count,
        COUNT(CASE WHEN status = 'p' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'd' THEN 1 END) as denied_count,
        AVG(longitude) as avg_longitude,
        AVG(latitude) as avg_latitude,
        MIN(submitted_at) as earliest_submission,
        MAX(submitted_at) as latest_submission
      FROM form_submission 
      GROUP BY location
    `);

    // Get requirement statistics by applies_to_location
    const [requirementStats] = await db.execute(`
      SELECT 
        fr.applies_to_location,
        fr.requirement_type,
        COUNT(*) as count
      FROM form_requirements fr
      JOIN form_submission fs ON fr.form_id = fs.id
      GROUP BY fr.applies_to_location, fr.requirement_type
      ORDER BY fr.applies_to_location, fr.requirement_type
    `);

    // Get bounding box of all submissions with coordinates
    const [boundingBox] = await db.execute(`
      SELECT 
        MIN(longitude) as min_lng,
        MAX(longitude) as max_lng,
        MIN(latitude) as min_lat,
        MAX(latitude) as max_lat
      FROM form_submission 
      WHERE longitude IS NOT NULL AND latitude IS NOT NULL
    `);

    res.json({
      success: true,
      data: {
        location_statistics: locationStats,
        requirement_statistics: requirementStats,
        bounding_box: boundingBox[0] || null
      }
    });
  } catch (error) {
    console.error('Error fetching location statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;