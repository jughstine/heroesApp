const express = require('express');
const router = express.Router();
const { getPool } = require('../config/database');

// Database connection health check (same as users router)
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

// Health check endpoint for the forms system
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
        forms: 'operational'
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

router.get('/types', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const [rows] = await conn.execute('SELECT * FROM form_type');
    
    res.json({ 
      success: true, 
      data: rows,
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching form types:', error);
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
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a new form (UPDATING - form_type_id = 5)
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata, 
      abroad_status 
    } = req.body;

    // Set form_type_id to 5 for UPDATING
    const form_type_id = 5;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Determine location status based on abroad_status
    const locationStatus = abroad_status ? 'abr' : 'loc';
    
    // Insert form submission with location data and location status
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, locationStatus, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion by querying the record
    const [insertedRecord] = await conn.execute(
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

      await conn.execute(
        `INSERT INTO upd_requirements (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
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

    await conn.commit();

    const processingTime = Date.now() - startTime;

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
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Form submission failed due to server error",
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
    // Always release connection
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a RESUMPTION form (form_type_id = 2)
router.post('/submit-resumption', async (req, res) => {
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata, 
      late_filing_status 
    } = req.body;

    // Set form_type_id to 2 for RESUMPTION
    const form_type_id = 2;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Resumption forms are always 'loc' (local) - pensioners are back in Philippines
    const locationStatus = 'loc';
    
    // Insert form submission with location data and location status
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, locationStatus, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion by querying the record
    const [insertedRecord] = await conn.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    // Insert form requirements into rsm_requirements table
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      // Insert into rsm_requirements table (specific for resumption forms)
      await conn.execute(
        `INSERT INTO rsm_requirements (form_id, requirement_type, value, file_url, file_key, file_type) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          formSubmissionId, 
          requirement_type, 
          value || null, 
          file_url || null, 
          file_key || null, 
          file_type || null
        ]
      );
    }

    await conn.commit();

    const processingTime = Date.now() - startTime;

    const responseData = {
      success: true,
      message: 'Resumption form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        form_type: 'resumption',
        location_status: locationStatus,
        late_filing_status: late_filing_status || false,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        }
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting resumption form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Resumption form submission failed due to server error",
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
    // Always release connection
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a RESTORATION -WIDOW form (form_type_id = 3)
router.post('/widow-restoration/submit', async (req, res) => {
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata,
      video_metadata,
      applies_to_location // 'loc', 'abr', or 'both'
    } = req.body;

    const form_type_id = 3;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate applies_to_location
    if (!applies_to_location || !['loc', 'abr', 'both'].includes(applies_to_location)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid applies_to_location. Must be "loc", "abr", or "both"',
        code: 'INVALID_LOCATION',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate required widow restoration documents
    const requiredTypes = ['video_submission', 'home_address', 'mobile_number', 'puf', 'jago_declaration', 'afp_id', 'pension_acc'];
    const providedTypes = requirements.map(r => r.requirement_type);
    
    const missingRequired = requiredTypes.filter(type => !providedTypes.includes(type));
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required documents: ${missingRequired.join(', ')}`,
        code: 'MISSING_REQUIREMENTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Insert form submission with location data
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, applies_to_location, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion
    const [insertedRecord] = await conn.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      // Validate requirement_type against allowed enum values
      const validTypes = [
        'video_submission',
        'home_address',
        'mobile_number',
        'puf',
        'jago_declaration',
        'afp_id',
        'pension_acc',
        'psa_crs5',
        'affidavit_late_filing'
      ];

      if (!validTypes.includes(requirement_type)) {
        throw new Error(`Invalid requirement_type: ${requirement_type}`);
      }

      await conn.execute(
        `INSERT INTO rst_widow_requirements 
         (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
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

    await conn.commit();

    const processingTime = Date.now() - startTime;

    const responseData = {
      success: true,
      message: 'Widow restoration form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        form_type: 'widow_restoration',
        location_status: applies_to_location,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        },
        video_metadata: video_metadata || null
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
        console.log('⚠️ Transaction rolled back');
      } catch (rollbackError) {
        console.error("❌ Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting widow restoration form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Widow restoration form submission failed due to server error",
      details: error.message,
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

    if (error.code === 'ER_NO_SUCH_TABLE') {
      errorResponse.error = "Database table 'rst_widow_requirements' not found. Please contact system administrator.";
      errorResponse.code = 'TABLE_NOT_FOUND';
      return res.status(500).json(errorResponse);
    }

    res.status(500).json(errorResponse);

  } finally {
    // Always release connection
    if (conn) {
      try {
        conn.release();
        console.log("✅ Database connection released");
      } catch (releaseError) {
        console.error("❌ Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a RESTORATION - PRINCIPAL form 
router.post('/principal-restoration/submit', async (req, res) => {
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata,
      video_metadata,
      applies_to_location // 'loc', 'abr', or 'both'
    } = req.body;

    const form_type_id = 3;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate applies_to_location
    if (!applies_to_location || !['loc', 'abr', 'both'].includes(applies_to_location)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid applies_to_location. Must be "loc", "abr", or "both"',
        code: 'INVALID_LOCATION',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate required widow restoration documents
    const requiredTypes = ['video_submission', 'home_address', 'mobile_number', 'puf', 'afp_id', 'pension_acc'];
    const providedTypes = requirements.map(r => r.requirement_type);
    
    const missingRequired = requiredTypes.filter(type => !providedTypes.includes(type));
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required documents: ${missingRequired.join(', ')}`,
        code: 'MISSING_REQUIREMENTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Insert form submission with location data
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, applies_to_location, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion
    const [insertedRecord] = await conn.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    console.log('✅ Form submission created:', {
      form_id: formSubmissionId,
      user_id,
      form_type_id,
      location: applies_to_location
    });

    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      // Validate requirement_type against allowed enum values
      const validTypes = [
        'video_submission',
        'home_address',
        'mobile_number',
        'puf',
        'afp_id',
        'pension_acc',
        'affidavit_late_filing'
      ];

      if (!validTypes.includes(requirement_type)) {
        throw new Error(`Invalid requirement_type: ${requirement_type}`);
      }

      await conn.execute(
        `INSERT INTO rst_principal_requirements 
         (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
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

      console.log(`✅ Inserted requirement: ${requirement_type}`);
    }

    await conn.commit();
    console.log('✅ Transaction committed successfully');

    const processingTime = Date.now() - startTime;

    const responseData = {
      success: true,
      message: 'Restoration form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        form_type: 'widow_restoration',
        location_status: applies_to_location,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        },
        video_metadata: video_metadata || null
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    console.log('✅ Response prepared:', responseData);
    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
        console.log('⚠️ Transaction rolled back');
      } catch (rollbackError) {
        console.error("❌ Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting widow restoration form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Widow restoration form submission failed due to server error",
      details: error.message,
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

    if (error.code === 'ER_NO_SUCH_TABLE') {
      errorResponse.error = "Database table 'rst_principal_requirements' not found. Please contact system administrator.";
      errorResponse.code = 'TABLE_NOT_FOUND';
      return res.status(500).json(errorResponse);
    }

    res.status(500).json(errorResponse);

  } finally {
    // Always release connection
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("❌ Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a RESTORATION - BI-PRINCIPAL form 
router.post('/biprincipal-restoration/submit', async (req, res) => {
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata,
      video_metadata,
      applies_to_location // 'loc', 'abr', or 'both'
    } = req.body;

    const form_type_id = 3;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate applies_to_location
    if (!applies_to_location || !['loc', 'abr', 'both'].includes(applies_to_location)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid applies_to_location. Must be "loc", "abr", or "both"',
        code: 'INVALID_LOCATION',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate required bi-principal restoration documents
    const requiredTypes = [
      'video_submission', 
      'home_address', 
      'mobile_number', 
      'puf', 
      'affidavit_late_filing',
      'birth_cert',
      'brgy_clear',
      'police_clear',
      'nbi_clear',
      'afp_id',
      'pen_account'
    ];
    const providedTypes = requirements.map(r => r.requirement_type);
    
    const missingRequired = requiredTypes.filter(type => !providedTypes.includes(type));
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required documents: ${missingRequired.join(', ')}`,
        code: 'MISSING_REQUIREMENTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Insert form submission with location data
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, applies_to_location, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion
    const [insertedRecord] = await conn.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      // Validate requirement_type against allowed enum values for bi-principal
      const validTypes = [
        'video_submission',
        'home_address',
        'mobile_number',
        'puf',
        'affidavit_late_filing',
        'birth_cert',
        'brgy_clear',
        'police_clear',
        'nbi_clear',
        'afp_id',
        'pen_account'
      ];

      if (!validTypes.includes(requirement_type)) {
        throw new Error(`Invalid requirement_type: ${requirement_type}`);
      }

      await conn.execute(
        `INSERT INTO rst_bi_principal_requirements 
         (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
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

    await conn.commit();

    const processingTime = Date.now() - startTime;

    const responseData = {
      success: true,
      message: 'Bi-principal restoration form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        form_type: 'biprincipal_restoration',
        location_status: applies_to_location,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        },
        video_metadata: video_metadata || null
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("❌ Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting bi-principal restoration form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Bi-principal restoration form submission failed due to server error",
      details: error.message,
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

    if (error.code === 'ER_NO_SUCH_TABLE') {
      errorResponse.error = "Database table 'rst_bi_principal_requirements' not found. Please contact system administrator.";
      errorResponse.code = 'TABLE_NOT_FOUND';
      return res.status(500).json(errorResponse);
    }

    res.status(500).json(errorResponse);

  } finally {
    // Always release connection
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("❌ Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a RESTORATION - RE-ENTITLEMENT form 
router.post('/reentitlement-restoration/submit', async (req, res) => {
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata,
      video_metadata,
      applies_to_location // 'loc', 'abr', or 'both'
    } = req.body;

    const form_type_id = 3;

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate applies_to_location
    if (!applies_to_location || !['loc', 'abr', 'both'].includes(applies_to_location)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid applies_to_location. Must be "loc", "abr", or "both"',
        code: 'INVALID_LOCATION',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate required re-entitlement restoration documents
    const requiredTypes = [
      'video_submission',
      'home_address',
      'mobile_number',
      'cert_of_naturalization',
      'oath_of_allegiance',
      'order_approval',
      'identif_cert',
      'afp_id',
      'atm_account',
      'puf',
      'affidavit_late_filing'
    ];
    const providedTypes = requirements.map(r => r.requirement_type);
    
    const missingRequired = requiredTypes.filter(type => !providedTypes.includes(type));
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required documents: ${missingRequired.join(', ')}`,
        code: 'MISSING_REQUIREMENTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Insert form submission with location data
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, applies_to_location, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion
    const [insertedRecord] = await conn.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      // Validate requirement_type against allowed enum values for re-entitlement
      const validTypes = [
        'video_submission',
        'home_address',
        'mobile_number',
        'cert_of_naturalization',
        'oath_of_allegiance',
        'order_approval',
        'identif_cert',
        'afp_id',
        'atm_account',
        'puf',
        'affidavit_late_filing'
      ];

      if (!validTypes.includes(requirement_type)) {
        throw new Error(`Invalid requirement_type: ${requirement_type}`);
      }

      await conn.execute(
        `INSERT INTO rst_re_entitle_requirements 
         (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
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

    await conn.commit();

    const processingTime = Date.now() - startTime;

    const responseData = {
      success: true,
      message: 'Re-entitlement restoration form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        form_type: 'reentitlement_restoration',
        location_status: applies_to_location,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        },
        video_metadata: video_metadata || null
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("❌ Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting re-entitlement restoration form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Re-entitlement restoration form submission failed due to server error",
      details: error.message,
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

    if (error.code === 'ER_NO_SUCH_TABLE') {
      errorResponse.error = "Database table 'rst_re_entitle_requirements' not found. Please contact system administrator.";
      errorResponse.code = 'TABLE_NOT_FOUND';
      return res.status(500).json(errorResponse);
    }

    res.status(500).json(errorResponse);

  } finally {
    // Always release connection
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("❌ Connection release error:", releaseError);
      }
    }
  }
});

// POST - Submit a RESTORATION - BI-BENEFICIARY form 
router.post('/bibeneficiary-restoration/submit', async (req, res) => {
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
    await conn.beginTransaction();

    const { 
      user_id, 
      longitude, 
      latitude, 
      requirements, 
      location_metadata,
      video_metadata,
      applies_to_location // 'loc', 'abr', or 'both'
    } = req.body;

    const form_type_id = 3; 

    // Validate required fields
    if (!user_id || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: user_id and requirements array',
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate applies_to_location
    if (!applies_to_location || !['loc', 'abr', 'both'].includes(applies_to_location)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid applies_to_location. Must be "loc", "abr", or "both"',
        code: 'INVALID_LOCATION',
        processingTime: `${Date.now() - startTime}ms`
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
          error: 'Invalid longitude value',
          code: 'INVALID_LONGITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (latitude !== null && latitude !== undefined && latitude !== '') {
      finalLatitude = Number(latitude);
      if (isNaN(finalLatitude)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value',
          code: 'INVALID_LATITUDE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate location data if provided
    if (finalLongitude !== null && finalLatitude !== null) {
      if (finalLongitude < -180 || finalLongitude > 180) {
        return res.status(400).json({
          success: false,
          error: 'Invalid longitude value. Must be between -180 and 180',
          code: 'LONGITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }

      if (finalLatitude < -90 || finalLatitude > 90) {
        return res.status(400).json({
          success: false,
          error: 'Invalid latitude value. Must be between -90 and 90',
          code: 'LATITUDE_OUT_OF_RANGE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Validate required bi-beneficiary restoration documents
    const requiredTypes = [
      'video_submission',
      'home_address',
      'mobile_number',
      'puf',
      'affidavit_late_filing',
      'birth_cert',
      'psa_crs5_h',
      'psa_crs5_w',
      'brgy_clear',
      'police_clear',
      'nbi_clear',
      'jago_declaration',
      'atm_account',
      'afp_id',
      'valid_id_1',
      'valid_id_2'
    ];
    const providedTypes = requirements.map(r => r.requirement_type);
    
    const missingRequired = requiredTypes.filter(type => !providedTypes.includes(type));
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required documents: ${missingRequired.join(', ')}`,
        code: 'MISSING_REQUIREMENTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Insert form submission with location data
    const [submissionResult] = await conn.execute(
      `INSERT INTO form_submission (user_id, form_type_id, longitude, latitude, location, status, submitted_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [user_id, form_type_id, finalLongitude, finalLatitude, applies_to_location, 'p'] // 'p' for pending
    );

    const formSubmissionId = submissionResult.insertId;

    // Verify the insertion
    const [insertedRecord] = await conn.execute(
      'SELECT id, user_id, form_type_id, longitude, latitude, location, status, submitted_at FROM form_submission WHERE id = ?',
      [formSubmissionId]
    );
    
    for (const requirement of requirements) {
      const { requirement_type, value, file_url, file_key, file_type } = requirement;

      if (!requirement_type) {
        throw new Error('requirement_type is required for all requirements');
      }

      // Validate requirement_type against allowed enum values for bi-beneficiary
      const validTypes = [
        'video_submission',
        'home_address',
        'mobile_number',
        'puf',
        'affidavit_late_filing',
        'birth_cert',
        'psa_crs5_h',
        'psa_crs5_w',
        'brgy_clear',
        'police_clear',
        'nbi_clear',
        'jago_declaration',
        'atm_account',
        'afp_id',
        'valid_id_1',
        'valid_id_2'
      ];

      if (!validTypes.includes(requirement_type)) {
        throw new Error(`Invalid requirement_type: ${requirement_type}`);
      }

      await conn.execute(
        `INSERT INTO rst_bi_bene_requirements 
         (form_id, requirement_type, value, file_url, file_key, file_type, applies_to_location) 
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

    await conn.commit();

    const processingTime = Date.now() - startTime;

    const responseData = {
      success: true,
      message: 'Bi-beneficiary restoration form submitted successfully',
      data: {
        form_id: formSubmissionId,
        form_type_id: form_type_id,
        form_type: 'bibeneficiary_restoration',
        location_status: applies_to_location,
        location: {
          longitude: finalLongitude,
          latitude: finalLatitude,
          accuracy: location_metadata?.accuracy,
          timestamp: location_metadata?.timestamp,
          was_recorded: finalLongitude !== null && finalLatitude !== null
        },
        video_metadata: video_metadata || null
      },
      meta: {
        processingTime: `${processingTime}ms`,
        submissionTime: new Date().toISOString()
      }
    };

    res.json(responseData);

  } catch (error) {
    // Rollback transaction if connection exists
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("❌ Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error('❌ Error submitting bi-beneficiary restoration form:', error);
    console.error('❌ Stack trace:', error.stack);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Bi-beneficiary restoration form submission failed due to server error",
      details: error.message,
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

    if (error.code === 'ER_NO_SUCH_TABLE') {
      errorResponse.error = "Database table 'rst_bi_bene_requirements' not found. Please contact system administrator.";
      errorResponse.code = 'TABLE_NOT_FOUND';
      return res.status(500).json(errorResponse);
    }

    res.status(500).json(errorResponse);

  } finally {
    // Always release connection
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("❌ Connection release error:", releaseError);
      }
    }
  }
});

// GET user's form submissions with location data
router.get('/user/:user_id', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { user_id } = req.params;

    const [rows] = await conn.execute(`
      SELECT fs.*, ft.name as form_type_name,
             fs.longitude, fs.latitude, fs.location as location_status
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      WHERE fs.user_id = ?
      ORDER BY fs.submitted_at DESC
    `, [user_id]);

    res.json({ 
      success: true, 
      data: rows,
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching user submissions:', error);
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
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET specific form submission with requirements and location
router.get('/:form_id', async (req, res) => {
  const startTime = Date.now();
  let conn = null;
  
  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { form_id } = req.params;

    // Get form submission details with location
    const [submissionRows] = await conn.execute(`
      SELECT fs.*, ft.name as form_type_name, u.email as user_email,
             fs.longitude, fs.latitude, fs.location as location_status
      FROM form_submission fs
      JOIN form_type ft ON fs.form_type_id = ft.id
      JOIN users_tbl u ON fs.user_id = u.id
      WHERE fs.id = ?
    `, [form_id]);

    if (submissionRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Form submission not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Get form requirements with applies_to_location
    const [requirementRows] = await conn.execute(
      'SELECT * FROM upd_requirements WHERE form_id = ? ORDER BY applies_to_location, requirement_type',
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

    res.json({ 
      success: true, 
      data: formData,
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching form submission:', error);
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
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET forms by location status (local vs abroad)
router.get('/location/:location_status', async (req, res) => {
  const startTime = Date.now();
  let conn = null;
  
  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { location_status } = req.params;

    // Validate location status
    if (!['loc', 'abr'].includes(location_status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid location_status. Must be "loc" (local) or "abr" (abroad)',
        code: 'INVALID_LOCATION_STATUS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const [rows] = await conn.execute(`
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
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching forms by location status:', error);
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
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET forms by location proximity 
router.get('/location/nearby', async (req, res) => {
  const startTime = Date.now();
  let conn = null;
  
  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    const { longitude, latitude, radius = 10 } = req.query;

    if (!longitude || !latitude) {
      return res.status(400).json({
        success: false,
        error: 'longitude and latitude parameters are required',
        code: 'MISSING_COORDINATES',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const lng = parseFloat(longitude);
    const lat = parseFloat(latitude);
    const radiusKm = parseFloat(radius);

    if (isNaN(lng) || isNaN(lat) || isNaN(radiusKm)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coordinate or radius values',
        code: 'INVALID_COORDINATES',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Using Haversine formula to calculate distance
    const [rows] = await conn.execute(`
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
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching nearby forms:', error);
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
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// PUT - Update form submission status
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
      'SELECT id, status, form_type_id, user_id FROM form_submission WHERE id = ?',
      [formId]
    );

    if (existingForm.length === 0) {
      return res.status(404).json({ success: false, error: 'Form submission not found' });
    }

    const formTypeId = existingForm[0].form_type_id;
    const userId = existingForm[0].user_id;

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

      // Conditional approval: If form type is 3 (Restoration) and status is approved
      if (formTypeId === 3 && status === 'a') {
        await pool.execute(
          'UPDATE users_tbl SET status = ?, approved_at = NOW() WHERE id = ?',
          ['TAG', userId]
        );
      }

      // Delete requirements from appropriate table if status is denied
      if (status === 'd') {
        if (formTypeId === 2) {
          // Resumption form
          await pool.execute('DELETE FROM rsm_requirements WHERE form_id = ?', [formId]);
        } else if (formTypeId === 3) {
          // Restoration form
          const result = await getFormType3TableForForm(pool, formId);
          const tableName = result.tableName;
          await pool.execute(`DELETE FROM ${tableName} WHERE form_id = ?`, [formId]);
        } else {
          // Form types 1, 5, and others use upd_requirementsments
          await pool.execute('DELETE FROM upd_requirements WHERE form_id = ?', [formId]);
        }
      }

      await pool.execute('COMMIT');

      const response = { 
        success: true, 
        message: 'Form status updated successfully',
        requirements_deleted: status === 'd',
        form_type_id: formTypeId,
        updated_by: {
          admin_id: adminId,
          admin_email: req.admin.email,
          admin_name: req.admin.name
        }
      };

      // Add user status update info if restoration form was approved
      if (formTypeId === 3 && status === 'a') {
        response.user_status_updated = true;
        response.new_user_status = 'TAG';
      }

      res.json(response);
    } catch (transactionError) {
      await pool.execute('ROLLBACK');
      throw transactionError;
    }
  } catch (error) {
    console.error('Error updating form status:', error);
    res.status(500).json({ success: false, error: 'Failed to update form status' });
  }
});

// GET location statistics with abroad/local breakdown
router.get('/analytics/location-stats', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const pool = getPool();
    conn = await pool.getConnection();
    
    // Get submission counts by location status
    const [locationStats] = await conn.execute(`
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
    const [requirementStats] = await conn.execute(`
      SELECT 
        fr.applies_to_location,
        fr.requirement_type,
        COUNT(*) as count
      FROM upd_requirements fr
      JOIN form_submission fs ON fr.form_id = fs.id
      GROUP BY fr.applies_to_location, fr.requirement_type
      ORDER BY fr.applies_to_location, fr.requirement_type
    `);

    // Get bounding box of all submissions with coordinates
    const [boundingBox] = await conn.execute(`
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
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching location statistics:', error);
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
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});


module.exports = router;