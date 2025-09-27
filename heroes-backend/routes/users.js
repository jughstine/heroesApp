const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const router = express.Router();
const { getConnection, executeQuery, healthCheck, logger } = require('../config/database');

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

// Enhanced health check
router.get("/health", async (req, res) => {
  const startTime = Date.now();

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
        availableEndpoints: [
          { method: "POST", path: "/api/users/signup", description: "signup" },
          { method: "POST", path: "/api/users/login", description: "signin" },
          { method: "GET", path: "/api/users/health", description: "health status" },
          { method: "POST", path: "/api/users/logout", description: "logout" }
        ],
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
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Rate limiting
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

const filterPassword = (password) => {
  if (typeof password !== 'string') return '';
  return password.replace(/[<>;"'`\\]/g, '').trim();
};

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

// Enhanced login endpoint with better error handling
router.post("/login", loginLimiter, sanitizeInput, async (req, res) => {
  const startTime = Date.now();

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

    const normalizedEmail = email.toLowerCase().trim();
    logger.info(`Login attempt for: ${normalizedEmail}`);

    const users = await executeQuery(`
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
      logger.warn(`Login failed - user not found: ${normalizedEmail}`);
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        code: 'INVALID_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const user = users[0];
    logger.info(`User found: ${user.email}, Status: ${user.user_status}`);

    if (user.user_status === 'SUS') {
      return res.status(403).json({
        success: false,
        error: "Account suspended. Please contact support.",
        code: 'ACCOUNT_SUSPENDED',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    
    if (!passwordMatch) {
      logger.warn(`Login failed - invalid password: ${normalizedEmail}`);
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
        code: 'INVALID_CREDENTIALS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Update last login (non-blocking)
    executeQuery('UPDATE users_tbl SET last_login = NOW() WHERE id = ?', [user.user_id])
      .catch(error => logger.warn('Failed to update last_login:', error.message));

    const processingTime = Date.now() - startTime;
    logger.info(`Login successful for ${normalizedEmail} in ${processingTime}ms`);

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
    logger.error("Login error:", {
      message: error.message,
      code: error.code,
      errno: error.errno,
      processingTime
    });

    // Determine specific error response
    let errorMessage = "Service temporarily unavailable. Please try again later.";
    let errorCode = 'SERVICE_ERROR';
    let statusCode = 500;

    if (error.code === 'PROTOCOL_CONNECTION_LOST' || 
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT') {
      errorMessage = "Database connection issue. Please try again in a moment.";
      errorCode = 'DB_CONNECTION_ERROR';
      statusCode = 503;
    } else if (error.message.includes('timeout')) {
      errorMessage = "Request timed out. Please try again.";
      errorCode = 'TIMEOUT_ERROR';
      statusCode = 503;
    } else if (error.message.includes('connection')) {
      errorMessage = "Database temporarily unavailable. Please try again.";
      errorCode = 'DB_UNAVAILABLE';
      statusCode = 503;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      code: errorCode,
      processingTime: `${processingTime}ms`
    });
  }
});

// Enhanced signup endpoint
router.post("/signup", signupLimiter, sanitizeInput, async (req, res) => {
  const startTime = Date.now();

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
        details: passwordValidation.errors,
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

    // Additional validation logic...
    const normalizedFirstname = firstname.trim().toUpperCase();
    const normalizedLastname = lastname.trim().toUpperCase();
    const normalizedAfpsn = afpsn.trim().toUpperCase();
    const normalizedEmail = email.toLowerCase().trim();

    // Check for existing email
    const existingUsers = await executeQuery(
      'SELECT id FROM users_tbl WHERE email = ? LIMIT 1', 
      [normalizedEmail]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ 
        success: false, 
        error: "An account with this email already exists",
        code: 'EMAIL_EXISTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Validate against heroes database
    const heroes = await executeQuery(`
      SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, CTRLNR 
      FROM test_table 
      WHERE UPPER(TRIM(FIRSTNAME)) = ? 
        AND UPPER(TRIM(LASTNAME)) = ? 
        AND DATE(DOB) = DATE(?) 
        AND UPPER(TRIM(AFPSN)) = ? 
        AND TYPE = ?`,
      [normalizedFirstname, normalizedLastname, dob, normalizedAfpsn, type]
    );

    if (heroes.length === 0) {
      return res.status(401).json({ 
        success: false, 
        error: "Authorization failed: Information does not match our records",
        code: 'NOT_AUTHORIZED',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    if (heroes.length > 1) {
      return res.status(409).json({ 
        success: false, 
        error: "Multiple matching records found. Please contact support.",
        code: 'DUPLICATE_RECORDS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const hero_ndx = heroes[0].NDX;

    // Check for existing user account
    const existingUser = await executeQuery(`
      SELECT u.id, u.email FROM users_tbl u 
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
      WHERE p.hero_ndx = ?`,
      [hero_ndx]
    );

    if (existingUser.length > 0) {
      return res.status(409).json({ 
        success: false, 
        error: "An account already exists for this record",
        code: 'ACCOUNT_EXISTS',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    // Use transaction for account creation
    const connection = await getConnection();
    
    try {
      await connection.beginTransaction();

      // Create account
      const saltRounds = 12;
      const hashedPassword = await bcrypt.hash(filteredPassword, saltRounds);
      
      const pensionerData = {
        hero_ndx,
        type,
        bos: type === 'P' && bos ? bos.trim().toUpperCase() : null,
        b_type: b_type || null,
        principal_firstname: type === 'B' ? principal_first_name?.trim().toUpperCase() : null,
        principal_lastname: type === 'B' ? principal_last_name?.trim().toUpperCase() : null
      };
      
      const [pensionerResult] = await connection.execute(
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
      
      const [userResult] = await connection.execute(
        `INSERT INTO users_tbl (pensioner_ndx, email, password_hash, status, created_at) 
         VALUES (?, ?, ?, 'UNV', NOW())`,
        [pensionerId, normalizedEmail, hashedPassword]
      );
      
      const userId = userResult.insertId;
      await connection.commit();

      const processingTime = Date.now() - startTime;
      logger.info(`Signup successful for ${normalizedEmail} in ${processingTime}ms`);

      res.status(201).json({
        success: true,
        message: "Account created successfully",
        user: {
          id: userId,
          email: normalizedEmail,
          pensioner_id: pensionerId,
          type: type,
          bos: pensionerData.bos,
          status: 'ACTIVE'
        },
        meta: {
          processingTime: `${processingTime}ms`,
          accountCreated: new Date().toISOString()
        }
      });

    } catch (insertError) {
      await connection.rollback();
      throw insertError;
    } finally {
      connection.release();
    }

  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error("Signup error:", {
      message: error.message,
      code: error.code,
      errno: error.errno,
      processingTime
    });

    let errorMessage = "Service temporarily unavailable. Please try again later.";
    let errorCode = 'SERVICE_ERROR';
    let statusCode = 500;

    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = "Account already exists";
      errorCode = 'DUPLICATE_ENTRY';
      statusCode = 409;
    } else if (error.code === 'PROTOCOL_CONNECTION_LOST' || 
               error.code === 'ECONNRESET' ||
               error.code === 'ETIMEDOUT') {
      errorMessage = "Database connection issue. Please try again in a moment.";
      errorCode = 'DB_CONNECTION_ERROR';
      statusCode = 503;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      code: errorCode,
      processingTime: `${processingTime}ms`
    });
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