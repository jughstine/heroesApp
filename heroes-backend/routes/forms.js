const express = require('express');
const router = express.Router();
const { pool: db } = require('../config/database');

// GET all form types
router.get('/types', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM form_type');
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching form types:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST - Submit a new form
router.post('/submit', async (req, res) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    console.log('📥 Form submission received');
    console.log('📍 Request body:', JSON.stringify(req.body, null, 2));

    const { user_id, form_type_id, longitude, latitude, requirements, video_metadata, location_metadata } = req.body;

    // Enhanced logging for location data
    console.log('🌍 Location data analysis:');
    console.log('  longitude:', longitude, '(type:', typeof longitude, ')');
    console.log('  latitude:', latitude, '(type:', typeof latitude, ')');
    console.log('  longitude === null:', longitude === null);
    console.log('  latitude === null:', latitude === null);
    console.log('  longitude === undefined:', longitude === undefined);
    console.log('  latitude === undefined:', latitude === undefined);

    // Validate required fields
    if (!user_id || !form_type_id || !requirements || !Array.isArray(requirements)) {
      console.log('❌ Missing required fields');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id, form_type_id, and requirements array'
      });
    }

    // Convert location values to proper types if they exist
    let finalLongitude = null;
    let finalLatitude = null;

    if (longitude !== null && longitude !== undefined && longitude !== '') {
      finalLongitude = Number(longitude);
      if (isNaN(finalLongitude)) {
        console.log('❌ Invalid longitude value:', longitude);
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value'
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        console.log('❌ Invalid latitude value:', latitude);
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value'
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      console.log('🔍 Validating coordinates...');
      
      // Validate longitude and latitude ranges
      if (finalLongitude < -180 || finalLongitude > 180) {
        console.log('❌ Longitude out of range:', finalLongitude);
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180'
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        console.log('❌ Latitude out of range:', finalLatitude);
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90'
        });
      }
      
      console.log('✅ Coordinates validated successfully');
      console.log('  Final longitude:', finalLongitude);
      console.log('  Final latitude:', finalLatitude);
    } else {
      console.log('⚠️ No location data to validate');
    }

    console.log('💾 Inserting form submission...');
    
    // Insert form submission with location data
    const [submissionResult] = await connection.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;
    console.log('✅ Form submission inserted with ID:', formSubmissionId);

    // Verify the insertion by querying the record
    const [insertedRecord] = await connection.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    console.log('🔍 Inserted record verification:');
    console.log(insertedRecord[0]);

    console.log('📝 Processing requirements...');
    
    // Insert form requirements
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      await connection.execute(
        `INSERT INTO form_requirements (form_id, requirement_type, value, file_url, file_key, file_type) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [formSubmissionId, requirement_type, value || null, file_url || null, file_key || null, file_type || null]
      );
    }

    console.log('✅ Requirements inserted successfully');

    // Log video metadata if provided (for debugging/analytics)
    if (video_metadata) {
      console.log('🎥 Video metadata for form', formSubmissionId, ':', video_metadata);
    }

    // Log location metadata if provided (for debugging/analytics)
    if (location_metadata) {
      console.log('📍 Location metadata for form', formSubmissionId, ':', {
        accuracy: location_metadata.accuracy,
        timestamp: new Date(location_metadata.timestamp),
        longitude: finalLongitude,
        latitude: finalLatitude
      });
    }

    await connection.commit();
    console.log('✅ Transaction committed successfully');

    const responseData = {
      success: true,
      message: 'Form submitted successfully',
      data: {
        form_id: formSubmissionId,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        }
      }
    };

    console.log('📤 Sending response:', responseData);
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
  try {
    const { user_id } = req.params;

    const [rows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name,
             fs.longitude, fs.latitude
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
  try {
    const { form_id } = req.params;

    // Get form submission details with location
    const [submissionRows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name, u.email as user_email,
             fs.longitude, fs.latitude
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      WHERE fs.id = ?
    `, [form_id]);

    if (submissionRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    // Get form requirements
    const [requirementRows] = await db.execute(
      'SELECT * FROM form_requirements WHERE form_id = ?',
      [form_id]
    );

    const formData = {
      ...submissionRows[0],
      requirements: requirementRows,
      location: {
        longitude: submissionRows[0].longitude,
        latitude: submissionRows[0].latitude
      }
    };

    res.json({ success: true, data: formData });
  } catch (error) {
    console.error('Error fetching form submission:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET forms by location proximity (bonus feature)
router.get('/location/nearby', async (req, res) => {
  try {
    const { longitude, latitude, radius = 10 } = req.query; // radius in kilometers

    if (!longitude || !latitude) {
      return res.status(400).json({
        success: false,
        error: 'longitude and latitude parameters are required'
      });
    }

    // Convert to numbers
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
    // Note: This is a simplified query. For production, consider using spatial database features
    const [rows] = await db.execute(`
      SELECT fs.*, ft.name as form_type_name,
             fs.longitude, fs.latitude,
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

// GET location statistics (bonus feature for analytics)
router.get('/analytics/location-stats', async (req, res) => {
  try {
    // Get submission counts by general location areas
    // This is a simplified example - you might want to implement proper geohashing or administrative boundaries
    const [stats] = await db.execute(`
      SELECT 
        COUNT(*) as total_submissions,
        AVG(longitude) as avg_longitude,
        AVG(latitude) as avg_latitude,
        MIN(submitted_at) as earliest_submission,
        MAX(submitted_at) as latest_submission,
        status,
        COUNT(CASE WHEN status = 'a' THEN 1 END) as approved_count,
        COUNT(CASE WHEN status = 'p' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'd' THEN 1 END) as denied_count
      FROM form_submission 
      WHERE longitude IS NOT NULL AND latitude IS NOT NULL
      GROUP BY status
    `);

    // Get bounding box of all submissions
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
        statistics: stats,
        bounding_box: boundingBox[0] || null
      }
    });
  } catch (error) {
    console.error('Error fetching location statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;