const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const { pool } = require("../config/database");
const router = express.Router();
const { getPool } = require('../config/database');


// Rate limiting for signup attempts
const signupLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    error: 'Too many signup attempts from this IP, please try again after 15 minutes.',
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

// password filtering function
const filterPassword = (password) => {
  if (typeof password !== 'string') return '';
  
  // Remove potentially dangerous characters that could be used for injection
  // Allow alphanumeric and common password special characters
  return password.replace(/[<>;"'`\\]/g, '').trim();
};

// password validation with comprehensive checks
const validatePasswordStrength = (password) => {
  const minLength = 8;
  const maxLength = 128;
  const hasNumber = /\d/.test(password);
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const hasMinLength = password.length >= minLength;
  const hasMaxLength = password.length <= maxLength;
  const noRepeatedChars = !/(.)\1{2,}/.test(password); // No more than 2 repeated chars
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

// Database connection health check
const checkDatabaseHealth = async () => {
  try {
    const pool = getPool(); // now defined
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};


//signup 
router.post("/signup", signupLimiter, sanitizeInput, async (req, res) => {
  const startTime = Date.now();
  let conn;

  try {
    const {
      email,
      password,
      type,        // 'P' or 'B'
      b_type,      // 'SP','CH','PR','SB' if Beneficiary
      bos,         // 'AR','AF','NV','PC' - Branch of Service
      principal_first_name,
      principal_last_name,
      firstname,
      lastname,
      dob,
      afpsn
    } = req.body;

    const requiredFields = { email, password, type, bos, firstname, lastname, dob, afpsn };
    const missingFields = Object.entries(requiredFields)

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
        error: "Password contains invalid characters. Please use only letters, numbers, and common special characters.",
        code: 'INVALID_PASSWORD_CHARS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const passwordValidation = validatePasswordStrength(filteredPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({ 
        success: false, 
        error: "Password does not meet security requirements",
        details: passwordValidation.errors,
        code: 'WEAK_PASSWORD',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (!['P', 'B'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid pensioner type. Must be 'P' (Principal) or 'B' (Beneficiary)",
        code: 'INVALID_TYPE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate Branch of Service (only required for Principals)
    if (type === 'P') {
      if (!bos) {
        return res.status(400).json({ 
          success: false, 
          error: "Branch of service is required for Principal users",
          code: 'MISSING_BOS',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      if (!['AR', 'AF', 'NV', 'PC'].includes(bos)) {
        return res.status(400).json({ 
          success: false, 
          error: "Invalid branch of service. Must be 'AR' (Army), 'AF' (Air Force), 'NV' (Navy), or 'PC' (Philippine Coast Guard)",
          code: 'INVALID_BOS',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (type === 'B') {
      if (!b_type || !['SP', 'CH', 'PR', 'SB'].includes(b_type)) {
        return res.status(400).json({ 
          success: false, 
          error: "Beneficiary must have valid type: SP (Spouse), CH (Child), PR (Parent), SB (Sibling)",
          code: 'INVALID_BENEFICIARY_TYPE',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      if (!principal_first_name || !principal_last_name) {
        return res.status(400).json({ 
          success: false, 
          error: "Beneficiary must provide principal's first and last name",
          code: 'MISSING_PRINCIPAL_INFO',
          processingTime: `${Date.now() - startTime}ms`
        });
      }
    }

    if (!validator.isDate(dob) || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return res.status(400).json({ 
        success: false, 
        error: "Date of birth must be in YYYY-MM-DD format and be a valid date",
        code: 'INVALID_DATE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const normalizedFirstname = firstname.trim().toUpperCase();
    const normalizedLastname = lastname.trim().toUpperCase();
    const normalizedAfpsn = afpsn.trim().toUpperCase();
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedBos = type === 'P' && bos ? bos.trim().toUpperCase() : null;

    const [rows] = await conn.query(
      `SELECT id FROM users_tbl WHERE email = ? LIMIT 1`,
      [normalizedEmail]
    );

    const existingEmail = rows[0];

    if (existingEmail) {
      await conn.rollback();
      return res.status(409).json({ 
        success: false, 
        error: "An account with this email address already exists",
        code: 'EMAIL_EXISTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Updated query - BOS is NOT in test_table, only validating existing fields
    const [heroes] = await conn.query(
      `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, CTRLNR 
       FROM test_table 
       WHERE UPPER(TRIM(FIRSTNAME)) = ? 
         AND UPPER(TRIM(LASTNAME)) = ? 
         AND DATE(DOB) = DATE(?) 
         AND UPPER(TRIM(AFPSN)) = ? 
         AND TYPE = ?`,
      [normalizedFirstname, normalizedLastname, dob, normalizedAfpsn, type]
    );

    console.log(`Heroes validation query returned ${heroes.length} record(s)`);

    if (heroes.length === 0) {
      await conn.rollback();
      return res.status(401).json({ 
        success: false, 
        error: "Authorization failed: Your information does not match any records in the AFP Heroes database.",
        details: "Only validated AFP personnel and their beneficiaries can register. Please verify your information or contact your unit administrator.",
        code: 'NOT_AUTHORIZED',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (heroes.length > 1) {
      await conn.rollback();
      return res.status(409).json({ 
        success: false, 
        error: "Multiple matching records found in Heroes database. Please contact system administrator for assistance.",
        code: 'DUPLICATE_RECORDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const hero_ndx = heroes[0].NDX;
    const validatedRecord = heroes[0];
    const [existingUser] = await conn.query(
      `SELECT u.id, u.email FROM users_tbl u 
       JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
       WHERE p.hero_ndx = ?`,
      [hero_ndx]
    );

    if (existingUser.length > 0) {
      await conn.rollback();
      return res.status(409).json({ 
        success: false, 
        error: "This AFP Hero record already has an associated user account.",
        details: "Each validated AFP personnel can only have one account. If you've forgotten your login details, please use the password reset feature.",
        code: 'ACCOUNT_EXISTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const saltRounds = 12; // Increased from 10 for better security
    const hashedPassword = await bcrypt.hash(filteredPassword, saltRounds);
    const pensionerData = {
      hero_ndx,
      type,
      bos: normalizedBos, // Will be null for Beneficiaries
      b_type: b_type || null,
      principal_firstname: type === 'B' ? principal_first_name?.trim().toUpperCase() : null,
      principal_lastname: type === 'B' ? principal_last_name?.trim().toUpperCase() : null
    };
    
    // Updated INSERT query to include BOS
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

    const successResponse = {
      success: true,
      message: "Account created successfully for validated AFP Hero",
      user: {
        id: userId,
        email: normalizedEmail,
        pensioner_id: pensionerId,
        type: type,
        bos: normalizedBos, // Will be null for Beneficiaries
        status: 'ACTIVE',
        validated_hero: {
          name: `${validatedRecord.FIRSTNAME} ${validatedRecord.LASTNAME}`,
          afpsn: validatedRecord.AFPSN,
          control_number: validatedRecord.CTRLNR,
          type: validatedRecord.TYPE
        },
        // Include principal names if beneficiary
        ...(type === 'B' && {
          principal_info: {
            firstname: principal_first_name.trim().toUpperCase(),
            lastname: principal_last_name.trim().toUpperCase(),
            relationship: b_type
          }
        })
      },
      meta: {
        processingTime: `${processingTime}ms`,
        accountCreated: new Date().toISOString()
      }
    };

    res.status(201).json(successResponse);

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
    console.error("=== SIGNUP ERROR ===");
    console.error("Error details:", error);
    console.error(`Processing time: ${processingTime}ms`);

    // Handle specific error types
    let errorResponse = {
      success: false,
      error: "Account creation failed due to server error",
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    };

    if (error.code === 'ER_DUP_ENTRY') {
      errorResponse.error = "Account with this information already exists";
      errorResponse.code = 'DUPLICATE_ENTRY';
      return res.status(409).json(errorResponse);
    }
    
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

    // Generic server error
    res.status(500).json(errorResponse);

  } finally {
    // Always release connection
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// Health check endpoint for the signup system
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
        signup: 'operational'
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


//login

// Rate limiting for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
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

// Login endpoint
router.post("/login", loginLimiter, sanitizeInput, async (req, res) => {
  const startTime = Date.now();
  const pool = getPool();
  let conn = null;

  try {
    console.log("=== LOGIN PROCESS STARTED ===");
    
    const { email, password } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
        code: 'MISSING_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Email validation
    if (!validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid email address",
        code: 'INVALID_EMAIL',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

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

    // Get database connection
    conn = await pool.getConnection(); // ✅ Now this works
    
    const normalizedEmail = email.toLowerCase().trim();

    // Find user with pensioner and hero information
    const [users] = await conn.query(`
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

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password",
        code: 'INVALID_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const user = users[0];

    // Check account status
    if (user.user_status === 'SUS') {
      return res.status(403).json({
        success: false,
        error: "Your account has been suspended. Please contact support for assistance.",
        code: 'ACCOUNT_SUSPENDED',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordMatch) {
      console.log("Invalid password attempt for user:", user.user_id);
      return res.status(401).json({
        success: false,
        error: "Invalid email or password",
        code: 'INVALID_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Update last login timestamp (optional)
    await conn.query(
      'UPDATE users_tbl SET last_login = NOW() WHERE id = ?',
      [user.user_id]
    );

    const processingTime = Date.now() - startTime;
    console.log(`=== LOGIN SUCCESSFUL (${processingTime}ms) ===`);

    // Return success response
    const loginResponse = {
      success: true,
      message: "Login successful",
      user: {
        id: user.user_id,
        email: user.email,
        pensioner_id: user.pensioner_id,
        type: user.type,
        bos: user.bos, // ✅ Added bos field
        status: 'ACTIVE',
        validated_hero: {
          name: `${user.FIRSTNAME} ${user.LASTNAME}`,
          afpsn: user.AFPSN,
          control_number: user.CTRLNR,
          type: user.hero_type
        },
        // Include principal info if beneficiary
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
    console.error("=== LOGIN ERROR ===");
    console.error("Error details:", error);
    console.error(`Processing time: ${processingTime}ms`);

    let errorResponse = {
      success: false,
      error: "Login failed due to server error",
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
    if (conn) {
      try {
        conn.release();
        console.log("Database connection released");
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
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