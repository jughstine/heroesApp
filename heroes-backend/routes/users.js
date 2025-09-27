const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const router = express.Router();
const { getPool, initializeDatabase, healthCheck } = require('../config/database');

router.get("/", async (req, res) => {
  res.json({
    success: true,
    message: "Users API endpoint",
    availableEndpoints: [
      "POST /api/users/signup",
      "POST /api/users/login", 
      "GET /api/users/health",
      "POST /api/users/logout"
    ]
  });
});

// Health check and available endpoints
router.get("/health", async (req, res) => {
  const startTime = Date.now();

  const availableEndpoints = [
    { method: "POST", path: "/api/users/signup", description: "signup" },
    { method: "POST", path: "/api/users/login", description: "signin" },
    { method: "GET", path: "/api/users/health", description: "health status" },
    { method: "POST", path: "/api/users/logout", description: "logout" }
  ];

  try {
    const health = await healthCheck();
    const processingTime = Date.now() - startTime;

    if (health.status === "healthy") {
      res.json({
        success: true,
        status: "healthy",
        services: {
          database: "healthy",
          signup: "operational",
          login: "operational",
          logout: "operational"
        },
        database: health.database,
        pool: health.pool,
        metrics: health.metrics,

        availableEndpoints,

        meta: {
          processingTime: `${processingTime}ms`,
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV || "development"
        }
      });
    } else {
      res.status(503).json({
        success: false,
        status: "degraded",
        error: health.error,
        availableEndpoints, 
        meta: {
          processingTime: `${processingTime}ms`,
          timestamp: new Date().toISOString()
        }
      });
    }
  } catch (error) {
    const processingTime = Date.now() - startTime;

    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: "Health check failed",
      details: error.message,
      availableEndpoints, 
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Rate limiting for signup attempts
const signupLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many signup attempts from this IP, please try again after 15 minutes.',
    retryAfter: 900,
    code: 'RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Too many login attempts from this IP, please try again after 15 minutes.',
    retryAfter: 900,
    code: 'RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const sanitizeInput = (req, res, next) => {
  const sanitizeString = (str) => {
    if (typeof str !== 'string') return str;
    return validator.escape(str.trim());
  };

  for (const key in req.body) {
    if (key !== 'password' && typeof req.body[key] === 'string') {
      req.body[key] = sanitizeString(req.body[key]);
    }
  }
  next();
};

// Password filtering 
const filterPassword = (password) => {
  if (typeof password !== 'string') return '';
  return password.replace(/[<>;"'`\\]/g, '').trim();
};

// Password validation with checks
const validatePasswordStrength = (password) => {
  const minLength = 8;
  const maxLength = 128;
  const hasNumber = /\d/.test(password);
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const hasMinLength = password.length >= minLength;
  const hasMaxLength = password.length <= maxLength;
  const noRepeatedChars = !/(.)\1{2,}/.test(password);
  const noCommonPatterns = !/^(123456|password|qwerty|abc123|admin|letmein)/i.test(password);

  const errors = [];
  if (!hasMinLength) errors.push("Password must be at least 8 characters");
  if (!hasMaxLength) errors.push("Password must be less than 128 characters");
  if (!hasNumber) errors.push("Password must contain at least one number");
  if (!hasLetter) errors.push("Password must contain at least one letter");
  if (!hasSpecialChar) errors.push("Password must contain at least one special character (!@#$%^&*(),.?\":{}|<>)");
  if (!noRepeatedChars) errors.push("Password cannot contain more than 2 repeated characters");
  if (!noCommonPatterns) errors.push("Password cannot be a common password");

  return {
    isValid: hasMinLength && hasMaxLength && hasNumber && hasLetter && hasSpecialChar && noRepeatedChars && noCommonPatterns,
    errors
  };
};

// health check 
const checkDatabaseHealth = async () => {
  let conn = null;
  
  try {
    console.log('Checking database health...');
    
    // Get the pool - don't reinitialize if it already exists
    let pool;
    try {
      pool = getPool();
      if (!pool) {
        console.log('Pool not found, initializing database...');
        await initializeDatabase();
        pool = getPool();
      }
    } catch (error) {
      console.log('Pool not initialized, initializing database...');
      await initializeDatabase();
      pool = getPool();
    }
    
    // Test connection with timeout
    const connectionTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
    
    const connectionPromise = pool.getConnection();
    
    conn = await Promise.race([connectionPromise, connectionTimeout]);
    
    // Test with a simple query
    await conn.execute('SELECT 1 as test');
    console.log('Database health check passed');
    return true;
    
  } catch (error) {
    console.error('Database health check failed:', error.message);
    console.error('Error details:', {
      code: error.code,
      errno: error.errno,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      message: error.message
    });
    return false;
  } finally {
    if (conn) {
      try {
        conn.release();
        console.log('Health check connection released');
      } catch (releaseError) {
        console.error('Error releasing health check connection:', releaseError);
      }
    }
  }
};

// Signup endpoint
router.post("/signup", signupLimiter, sanitizeInput, async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const {
      email,
      password,
      type,
      b_type,
      bos,
      principal_first_name,
      principal_last_name,
      firstname,
      lastname,
      dob,
      afpsn
    } = req.body;

    // Input validation 
    let requiredFields = { email, password, type, firstname, lastname, dob, afpsn };
    const missingFields = Object.entries(requiredFields)
      .filter(([key, value]) => !value || (typeof value === 'string' && value.trim() === ''))
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Missing required fields: ${missingFields.join(', ')}`,
        code: 'MISSING_FIELDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({ 
        success: false, 
        error: "Please enter a valid email address",
        code: 'INVALID_EMAIL',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const filteredPassword = filterPassword(password);
    
    if (filteredPassword !== password) {
      return res.status(400).json({ 
        success: false, 
        error: "Password contains invalid characters",
        code: 'INVALID_PASSWORD_CHARS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const passwordValidation = validatePasswordStrength(filteredPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({ 
        success: false, 
        error: "Password does not meet security requirements",
        code: 'WEAK_PASSWORD',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (!['P', 'B'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid pensioner type",
        code: 'INVALID_TYPE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (type === 'P') {
      if (!bos || !['AR', 'AF', 'NV', 'PC'].includes(bos)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid or missing branch of service for Principal users",
          code: 'INVALID_BOS',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (type === 'B') {
      if (!b_type || !['SP', 'CH', 'PR', 'SB'].includes(b_type)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid beneficiary type",
          code: 'INVALID_BENEFICIARY_TYPE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      if (!principal_first_name || !principal_last_name) {
        return res.status(400).json({ 
          success: false, 
          error: "Principal information required for beneficiaries",
          code: 'MISSING_PRINCIPAL_INFO',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (!validator.isDate(dob) || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid date format",
        code: 'INVALID_DATE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    let pool;
    try {
      pool = getPool();
      if (!pool) {
        await initializeDatabase();
        pool = getPool();
      }
    } catch (initError) {
      console.error('Database initialization error:', initError);
      return res.status(503).json({
        success: false,
        error: "Service temporarily unavailable. Please try again later.",
        code: 'SERVICE_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    try {
      const connectionTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout')), 15000);
      });
      
      conn = await Promise.race([pool.getConnection(), connectionTimeout]);
      await conn.beginTransaction();
      
    } catch (connError) {
      console.error('Database connection error:', connError);
      return res.status(503).json({
        success: false,
        error: "Service temporarily unavailable. Please try again later.",
        code: 'SERVICE_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Normalize data
    const normalizedFirstname = firstname.trim().toUpperCase();
    const normalizedLastname = lastname.trim().toUpperCase();
    const normalizedAfpsn = afpsn.trim().toUpperCase();
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedBos = type === 'P' && bos ? bos.trim().toUpperCase() : null;

    // Check for existing email with timeout
    try {
      const queryTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Query timeout')), 10000);
      });
      
      const [rows] = await Promise.race([
        conn.query(`SELECT id FROM users_tbl WHERE email = ? LIMIT 1`, [normalizedEmail]),
        queryTimeout
      ]);

      if (rows[0]) {
        await conn.rollback();
        return res.status(409).json({ 
          success: false, 
          error: "An account with this email already exists",
          code: 'EMAIL_EXISTS',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    } catch (queryError) {
      await conn.rollback();
      console.error('Email check query error:', queryError);
      return res.status(503).json({
        success: false,
        error: "Service temporarily unavailable. Please try again later.",
        code: 'SERVICE_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate against heroes database with timeout
    let heroes;
    try {
      const queryTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Query timeout')), 15000);
      });
      
      [heroes] = await Promise.race([
        conn.query(`
          SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, CTRLNR 
          FROM test_table 
          WHERE UPPER(TRIM(FIRSTNAME)) = ? 
            AND UPPER(TRIM(LASTNAME)) = ? 
            AND DATE(DOB) = DATE(?) 
            AND UPPER(TRIM(AFPSN)) = ? 
            AND TYPE = ?`,
          [normalizedFirstname, normalizedLastname, dob, normalizedAfpsn, type]
        ),
        queryTimeout
      ]);
    } catch (queryError) {
      await conn.rollback();
      console.error('Heroes validation query error:', queryError);
      return res.status(503).json({
        success: false,
        error: "Service temporarily unavailable. Please try again later.",
        code: 'SERVICE_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (heroes.length === 0) {
      await conn.rollback();
      return res.status(401).json({ 
        success: false, 
        error: "Authorization failed: Information does not match our records",
        code: 'NOT_AUTHORIZED',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (heroes.length > 1) {
      await conn.rollback();
      return res.status(409).json({ 
        success: false, 
        error: "Multiple matching records found. Please contact support.",
        code: 'DUPLICATE_RECORDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const hero_ndx = heroes[0].NDX;
    const validatedRecord = heroes[0];
    
    // Check for existing user account
    try {
      const queryTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Query timeout')), 10000);
      });
      
      const [existingUser] = await Promise.race([
        conn.query(`
          SELECT u.id, u.email FROM users_tbl u 
          JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
          WHERE p.hero_ndx = ?`,
          [hero_ndx]
        ),
        queryTimeout
      ]);

      if (existingUser.length > 0) {
        await conn.rollback();
        return res.status(409).json({ 
          success: false, 
          error: "An account already exists for this record",
          code: 'ACCOUNT_EXISTS',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    } catch (queryError) {
      await conn.rollback();
      console.error('Existing user check error:', queryError);
      return res.status(503).json({
        success: false,
        error: "Service temporarily unavailable. Please try again later.",
        code: 'SERVICE_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Create account
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(filteredPassword, saltRounds);
    
    const pensionerData = {
      hero_ndx,
      type,
      bos: normalizedBos,
      b_type: b_type || null,
      principal_firstname: type === 'B' ? principal_first_name?.trim().toUpperCase() : null,
      principal_lastname: type === 'B' ? principal_last_name?.trim().toUpperCase() : null
    };
    
    try {
      const [pensionerResult] = await conn.query(
        `INSERT INTO pensioners_tbl (hero_ndx, type, bos, b_type, principal_firstname, principal_lastname) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          pensionerData.hero_ndx, 
          pensionerData.type,
          pensionerData.bos,
          pensionerData.b_type,
          pensionerData.principal_firstname,
          pensionerData.principal_lastname
        ]
      );
      
      const pensionerId = pensionerResult.insertId;
      
      const [userResult] = await conn.query(
        `INSERT INTO users_tbl (pensioner_ndx, email, password_hash, status, created_at) 
         VALUES (?, ?, ?, 'UNV', NOW())`,
        [pensionerId, normalizedEmail, hashedPassword]
      );
      
      const userId = userResult.insertId;
      await conn.commit();

      const processingTime = Date.now() - startTime;

      res.status(201).json({
        success: true,
        message: "Account created successfully",
        user: {
          id: userId,
          email: normalizedEmail,
          pensioner_id: pensionerId,
          type: type,
          bos: normalizedBos,
          status: 'ACTIVE'
        },
        meta: {
          processingTime: `${processingTime}ms`,
          accountCreated: new Date().toISOString()
        }
      });

    } catch (insertError) {
      await conn.rollback();
      console.error('Database insert error:', insertError);
      
      if (insertError.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          error: "Account already exists",
          code: 'DUPLICATE_ENTRY',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      
      return res.status(503).json({
        success: false,
        error: "Service temporarily unavailable. Please try again later.",
        code: 'SERVICE_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

  } catch (error) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError);
      }
    }

    const processingTime = Date.now() - startTime;
    console.error("Signup error:", error.code || error.message);

    //  error response 
    res.status(500).json({
      success: false,
      error: "Service temporarily unavailable. Please try again later.",
      code: 'SERVICE_ERROR',
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

// login endpoint
router.post("/login", loginLimiter, sanitizeInput, async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
        code: 'MISSING_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid email address",
        code: 'INVALID_EMAIL',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Get database pool - it should already be initialized based on your logs
    let pool;
    try {
      pool = getPool();
    } catch (poolError) {
      console.error('Pool not available:', poolError.message);
      try {
        await initializeDatabase();
        pool = getPool();
      } catch (initError) {
        console.error('Database initialization failed:', initError);
        return res.status(503).json({
          success: false,
          error: "Database service temporarily unavailable. Please try again later.",
          code: 'DB_INITIALIZATION_FAILED',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    // Get connection with timeout using Promise.race
    try {
      console.log('Getting database connection...');
      
      const connectionPromise = pool.getConnection();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection acquisition timeout')), 30000);
      });
      
      conn = await Promise.race([connectionPromise, timeoutPromise]);
      console.log('Connection acquired successfully');
      
    } catch (connError) {
      console.error('Failed to get database connection:', connError.message);
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_CONNECTION_TIMEOUT',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();

    // Execute login query with manual timeout handling
    let users;
    try {
      console.log('Executing login query for:', normalizedEmail);
      
      const queryPromise = conn.query(`
        SELECT 
          u.id as user_id,
          u.email,
          u.password_hash,
          u.status as user_status,
          u.created_at,
          p.id as pensioner_id,
          p.type,
          p.bos,
          p.b_type,
          p.principal_firstname,
          p.principal_lastname,
          h.FIRSTNAME,
          h.LASTNAME,
          h.AFPSN,
          h.CTRLNR,
          h.TYPE as hero_type
        FROM users_tbl u
        JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
        JOIN test_table h ON p.hero_ndx = h.NDX
        WHERE u.email = ?
        LIMIT 1
      `, [normalizedEmail]);
      
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Query execution timeout')), 20000); // 20 second timeout
      });
      
      [users] = await Promise.race([queryPromise, timeoutPromise]);
      console.log('Login query completed, found:', users.length, 'users');
      
    } catch (queryError) {
      console.error('Login query failed:', queryError.message);
      
      // Check if it's a timeout or connection error
      if (queryError.message.includes('timeout')) {
        return res.status(503).json({
          success: false,
          error: "Database service temporarily unavailable. Please try again later.",
          code: 'DB_QUERY_TIMEOUT',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      
      // Check for connection lost errors
      if (queryError.code === 'PROTOCOL_CONNECTION_LOST' || 
          queryError.code === 'ECONNRESET') {
        return res.status(503).json({
          success: false,
          error: "Database service temporarily unavailable. Please try again later.",
          code: 'DB_CONNECTION_LOST',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      
      // Generic database error
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_QUERY_ERROR',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (users.length === 0) {
      console.log('No user found for email:', normalizedEmail);
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        code: 'INVALID_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const user = users[0];
    console.log('User found:', user.email, 'Status:', user.user_status);

    if (user.user_status === 'SUS') {
      return res.status(403).json({
        success: false,
        error: "Account suspended. Please contact support.",
        code: 'ACCOUNT_SUSPENDED',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Verify password
    console.log('Verifying password...');
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordMatch) {
      console.log('Password verification failed for:', normalizedEmail);
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        code: 'INVALID_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    console.log('Password verified successfully');

    // Update last login 
    try {
      const updatePromise = conn.query('UPDATE users_tbl SET last_login = NOW() WHERE id = ?', [user.user_id]);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Update timeout')), 5000);
      });
      
      await Promise.race([updatePromise, timeoutPromise]);
      console.log('Last login updated');
    } catch (updateError) {
      console.warn('Failed to update last_login (non-critical):', updateError.message);
      // Don't fail the login for this
    }

    const processingTime = Date.now() - startTime;
    console.log(`Login successful for ${normalizedEmail} in ${processingTime}ms`);

    const loginResponse = {
      success: true,
      message: "Login successful",
      user: {
        id: user.user_id,
        email: user.email,
        pensioner_id: user.pensioner_id,
        type: user.type,
        bos: user.bos, 
        status: 'ACTIVE',
        validated_hero: {
          name: `${user.FIRSTNAME} ${user.LASTNAME}`,
          afpsn: user.AFPSN,
          control_number: user.CTRLNR,
          type: user.hero_type
        },
        ...(user.type === 'B' && {
          principal_info: {
            firstname: user.principal_firstname,
            lastname: user.principal_lastname,
            relationship: user.b_type
          }
        })
      },
      meta: {
        processingTime: `${processingTime}ms`,
        loginTime: new Date().toISOString()
      }
    };

    res.json(loginResponse);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error("Unexpected login error:", error);

    res.status(500).json({
      success: false,
      error: "Database service temporarily unavailable. Please try again later.",
      code: 'UNEXPECTED_ERROR',
      processingTime: `${processingTime}ms`
    });

  } finally {
    if (conn) {
      try {
        conn.release();
        console.log('Connection released');
      } catch (releaseError) {
        console.error("Connection release error:", releaseError.message);
      }
    }
  }
});

// Logout endpoint
router.post("/logout", async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Logged out successfully",
      meta: {
        logoutTime: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Logout failed",
      code: 'LOGOUT_ERROR'
    });
  }
});

module.exports = router;