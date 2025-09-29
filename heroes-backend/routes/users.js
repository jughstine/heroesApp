const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const router = express.Router();
const { getConnection, executeQuery, healthCheck, testConnection, logger } = require('../config/database');

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

// health check
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
          { method: "POST", path: "/api/users/sigup", description: "signup" },
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
        code: health.code || 'HEALTH_CHECK_FAILED',
        meta: {
          processingTime: `${processingTime}ms`,
          timestamp: new Date().toISOString()
        }
      });
    }
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('Health check endpoint error:', error);
    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: "Health check failed",
      details: error.message,
      code: error.code || 'HEALTH_CHECK_ERROR',
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Rate limiting
const step1Limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    error: 'Too many validation attempts. Please try again later.',
    code: 'RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const step2Limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: 'Too many validation attempts. Please try again later.',
    code: 'RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const createAccountLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 5, // signup attempts
  message: {
    success: false,
    error: 'Too many account creation attempts. Please try again later.',
    code: 'RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 30 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many signup attempts from this IP, please try again after 30 minutes.',
    retryAfter: 1800,
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

// Database connection validation middleware
const validateDatabaseConnection = async (req, res, next) => {
  try {
    await testConnection();
    next();
  } catch (error) {
    logger.error('Database connection validation failed:', {
      code: error.code,
      message: error.message,
      endpoint: req.path
    });
    
    return res.status(503).json({
      success: false,
      error: "Database service temporarily unavailable. Please try again later.",
      code: 'DB_CONNECTION_FAILED',
      details: error.code || 'CONNECTION_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

const generateValidationToken = (data) => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, data };
};

const storeValidationToken = async (token, data, expiresInHours = 2) => {
  try {
    const expiresAt = new Date(Date.now() + (expiresInHours * 60 * 60 * 1000));
    
    // Ensure data is properly stringified
    const jsonData = typeof data === 'string' ? data : JSON.stringify(data);
    
    await executeQuery(
      `INSERT INTO signup_tokens (token, data, expires_at, created_at) 
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE 
         data = VALUES(data), 
         expires_at = VALUES(expires_at), 
         created_at = NOW()`,
      [token, jsonData, expiresAt]
    );
    
    logger.info(`Token stored successfully: ${token.substring(0, 8)}... (expires: ${expiresAt.toISOString()})`);
    return token;
  } catch (error) {
    logger.error('Failed to store validation token:', error);
    throw error;
  }
};


const getValidationToken = async (token) => {
  try {
    const results = await executeQuery(
      `SELECT data, expires_at, created_at FROM signup_tokens 
       WHERE token = ? AND expires_at > NOW()`,
      [token]
    );
    
    if (results.length === 0) {
      // Check if token exists but expired
      const expiredResults = await executeQuery(
        'SELECT expires_at, created_at FROM signup_tokens WHERE token = ?',
        [token]
      );
      
      if (expiredResults.length > 0) {
        logger.warn(`Token expired. Created: ${expiredResults[0].created_at}, Expired: ${expiredResults[0].expires_at}`);
        throw new Error('Validation token has expired');
      }
      
      logger.warn(`Token not found: ${token.substring(0, 8)}...`);
      throw new Error('Invalid validation token');
    }
    
    const tokenData = results[0].data;
    
    // Handle both string and object data
    let parsedData;
    if (typeof tokenData === 'string') {
      try {
        parsedData = JSON.parse(tokenData);
      } catch (parseError) {
        logger.error('JSON parse error for token data:', {
          error: parseError.message,
          tokenData: tokenData,
          tokenPrefix: token.substring(0, 8)
        });
        throw new Error('Invalid token data format');
      }
    } else if (typeof tokenData === 'object' && tokenData !== null) {
      parsedData = tokenData;
    } else {
      logger.error('Unexpected token data type:', {
        type: typeof tokenData,
        data: tokenData,
        tokenPrefix: token.substring(0, 8)
      });
      throw new Error('Invalid token data type');
    }
    
    logger.info(`Token retrieved successfully: ${token.substring(0, 8)}...`);
    return parsedData;
  } catch (error) {
    if (error.message.includes('expired') || error.message.includes('Invalid') || error.message.includes('token data')) {
      throw error; // Re-throw validation errors
    }
    logger.error('Database error in getValidationToken:', error);
    throw new Error('Token validation failed due to database error');
  }
};


const cleanupExpiredTokens = async () => {
  try {
    const nowTimestamp = Math.floor(Date.now() / 1000);
    
    const result = await executeQuery(
      'DELETE FROM signup_tokens WHERE UNIX_TIMESTAMP(expires_at) <= ?', 
      [nowTimestamp]
    );
    
    if (result.affectedRows > 0) {
      logger.info(`Cleaned up ${result.affectedRows} expired tokens`);
    }
  } catch (error) {
    logger.warn('Failed to cleanup expired tokens:', error.message);
  }
};

const debugTokenStatus = async (token) => {
  try {
    const results = await executeQuery(`
      SELECT 
        LEFT(token, 8) as token_prefix,
        created_at,
        expires_at,
        UNIX_TIMESTAMP(created_at) as created_ts,
        UNIX_TIMESTAMP(expires_at) as expires_ts,
        UNIX_TIMESTAMP(NOW()) as now_ts,
        (expires_at > NOW()) as is_valid,
        TIMESTAMPDIFF(MINUTE, NOW(), expires_at) as minutes_remaining
      FROM signup_tokens 
      WHERE token = ?`, 
      [token]
    );
    
    if (results.length > 0) {
      logger.info('Token debug info:', {
        tokenPrefix: results[0].token_prefix,
        createdAt: results[0].created_at,
        expiresAt: results[0].expires_at,
        isValid: results[0].is_valid === 1,
        minutesRemaining: results[0].minutes_remaining
      });
    } else {
      logger.warn(`Token not found in database: ${token.substring(0, 8)}...`);
    }
    
    return results[0] || null;
  } catch (error) {
    logger.error('Token debug failed:', error.message);
    return null;
  }
};

setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// SIGNUP 

// signup route handle
router.post("/signup", (req, res, next) => {

    const { step } = req.body;
    switch (step) {
      case 1:
        return step1Limiter(req, res, next);
      case 2:
        return step2Limiter(req, res, next);
      case 3:
        return createAccountLimiter(req, res, next);
      default:
        return step1Limiter(req, res, next); 
    }
  },
  sanitizeInput, 
  validateDatabaseConnection, 
  async (req, res) => {
    const startTime = Date.now();
    const { step = 1 } = req.body;

    try {
      switch (step) {
        case 1:
          return await handleStep1(req, res, startTime);
        case 2:
          return await handleStep2(req, res, startTime);
        case 3:
          return await handleStep3(req, res, startTime);
        default:
          return res.status(400).json({
            success: false,
            error: "Invalid step. Must be 1, 2, or 3.",
            code: 'INVALID_STEP',
            processingTime: `${Date.now() - startTime}ms`
          });
      }
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error(`Signup Step ${step} error:`, error);

      res.status(500).json({
        success: false,
        error: `Step ${step} failed. Please try again.`,
        code: `STEP${step}_ERROR`,
        processingTime: `${processingTime}ms`
      });
    }
  }
);

// STEP 1
async function handleStep1(req, res, startTime) {
  const { type, afpsn, bos, b_type, principal_first_name, principal_last_name } = req.body;

  // Basic validation
  if (!type || !afpsn) {
    return res.status(400).json({
      success: false,
      error: "Pensioner type and AFP Serial Number are required",
      code: 'MISSING_REQUIRED_FIELDS',
      step: 1,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  if (!['P', 'B'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: "Invalid pensioner type. Must be 'P' (Principal) or 'B' (Beneficiary)",
      code: 'INVALID_TYPE',
      step: 1,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  // Type-specific validation
  if (type === 'P' && !bos) {
    return res.status(400).json({
      success: false,
      error: "Branch of service is required for principal pensioners",
      code: 'MISSING_BOS',
      step: 1,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  if (type === 'B') {
    if (!b_type || !principal_first_name || !principal_last_name) {
      return res.status(400).json({
        success: false,
        error: "Beneficiary type and principal information are required for beneficiaries",
        code: 'MISSING_BENEFICIARY_INFO',
        step: 1,
        processingTime: `${Date.now() - startTime}ms`
      });
    }
  }

  const normalizedAfpsn = afpsn.trim().toUpperCase();

  const afpsnExists = await executeQuery(`
    SELECT COUNT(*) as count FROM test_table 
    WHERE UPPER(TRIM(AFPSN)) = ? AND TYPE = ?`,
    [normalizedAfpsn, type]
  );

  if (afpsnExists[0].count === 0) {
    return res.status(404).json({
      success: false,
      error: "AFP Serial Number not found in our records",
      code: 'AFPSN_NOT_FOUND',
      step: 1,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  const existingAccount = await executeQuery(`
    SELECT u.id FROM users_tbl u 
    JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
    JOIN test_table h ON p.hero_ndx = h.NDX 
    WHERE UPPER(TRIM(h.AFPSN)) = ? AND h.TYPE = ?`,
    [normalizedAfpsn, type]
  );

  if (existingAccount.length > 0) {
    return res.status(409).json({
      success: false,
      error: "An account already exists for this AFP Serial Number",
      code: 'ACCOUNT_EXISTS',
      step: 1,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  const tokenData = {
    type,
    afpsn: normalizedAfpsn,
    bos: type === 'P' ? bos?.trim().toUpperCase() : null,
    b_type: b_type || null,
    principal_first_name: type === 'B' ? principal_first_name?.trim().toUpperCase() : null,
    principal_last_name: type === 'B' ? principal_last_name?.trim().toUpperCase() : null,
    step: 1,
  };
  
  const { token } = generateValidationToken(tokenData);
  const step1Token = await storeValidationToken(token, tokenData);

  const processingTime = Date.now() - startTime;
  logger.info(`Step 1 validation successful for AFPSN: ${normalizedAfpsn} in ${processingTime}ms`);

  return res.json({
    success: true,
    message: "Step 1 validation completed successfully",
    step: 1,
    nextStep: 2,
    step1Token,
    data: {
      type,
      afpsn: normalizedAfpsn,
      recordsFound: afpsnExists[0].count
    },
    meta: {
      processingTime: `${processingTime}ms`,
      validUntil: new Date(Date.now() + 3600000).toISOString() // 1 hour
    }
  });
}

// STEP 2
async function handleStep2(req, res, startTime) {
  const { step1Token, firstname, lastname, dob } = req.body;

  if (!step1Token) {
    return res.status(400).json({
      success: false,
      error: "Step 1 validation token is required",
      code: 'MISSING_STEP1_TOKEN',
      step: 2,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  // Debug token in development only
  if (process.env.NODE_ENV === 'development') {
    try {
      await debugTokenStatus(step1Token);
    } catch (debugError) {
      logger.warn('Debug token status failed:', debugError.message);
    }
  }

  let step1Data;
  try {
    step1Data = await getValidationToken(step1Token);
    
    if (!step1Data || step1Data.step !== 1) {
      throw new Error('Invalid step sequence - expected step 1 data');
    }
    
    logger.info(`Step 1 data retrieved for validation: type=${step1Data.type}, afpsn=${step1Data.afpsn}`);
    
  } catch (error) {
    logger.warn(`Step 2 token validation failed: ${error.message}`);
    
    let errorCode = 'INVALID_STEP1_TOKEN';
    let errorMessage = "Invalid validation token. Please start over from Step 1.";
    
    if (error.message.includes('expired')) {
      errorCode = 'TOKEN_EXPIRED';
      errorMessage = "Your validation has expired. Please start over from Step 1.";
    } else if (error.message.includes('token data')) {
      errorCode = 'TOKEN_DATA_ERROR';
      errorMessage = "Token data is corrupted. Please start over from Step 1.";
    }
    
    return res.status(400).json({
      success: false,
      error: errorMessage,
      code: errorCode,
      step: 2,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  // Basic validation
  if (!firstname || !lastname || !dob) {
    return res.status(400).json({
      success: false,
      error: "First name, last name, and date of birth are required",
      code: 'MISSING_PERSONAL_INFO',
      step: 2,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  const normalizedFirstname = firstname.trim().toUpperCase();
  const normalizedLastname = lastname.trim().toUpperCase();

  // Validate against heroes database
  const heroes = await executeQuery(`
    SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, CTRLNR 
    FROM test_table 
    WHERE UPPER(TRIM(FIRSTNAME)) = ? 
      AND UPPER(TRIM(LASTNAME)) = ? 
      AND DATE(DOB) = DATE(?) 
      AND UPPER(TRIM(AFPSN)) = ? 
      AND TYPE = ?`,
    [normalizedFirstname, normalizedLastname, dob, step1Data.afpsn, step1Data.type]
  );

  if (heroes.length === 0) {
    logger.warn(`No matching hero found for: ${normalizedFirstname} ${normalizedLastname}, DOB: ${dob}, AFPSN: ${step1Data.afpsn}`);
    return res.status(401).json({
      success: false,
      error: "Personal information does not match our records. Please verify your details.",
      code: 'PERSONAL_INFO_MISMATCH',
      step: 2,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  if (heroes.length > 1) {
    logger.warn(`Multiple heroes found for: ${normalizedFirstname} ${normalizedLastname}`);
    return res.status(409).json({
      success: false,
      error: "Multiple matching records found. Please contact support.",
      code: 'DUPLICATE_RECORDS',
      step: 2,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  const heroData = heroes[0];
  logger.info(`Hero matched: ${heroData.FIRSTNAME} ${heroData.LASTNAME} (${heroData.AFPSN})`);

  // Create step 2 token data
  const step2TokenData = {
    ...step1Data, // Include all step 1 data
    firstname: normalizedFirstname,
    lastname: normalizedLastname,
    dob,
    hero_ndx: heroData.NDX,
    hero_ctrl_nr: heroData.CTRLNR,
    step: 2,
    validated_at: new Date().toISOString()
  };
  
  // Generate and store step 2 token
  const { token } = generateValidationToken(step2TokenData);
  const step2Token = await storeValidationToken(token, step2TokenData, 2); // 2 hours

  const processingTime = Date.now() - startTime;
  logger.info(`Step 2 validation successful for: ${normalizedFirstname} ${normalizedLastname} in ${processingTime}ms`);

  return res.json({
    success: true,
    message: "Step 2 validation completed - Record matched!",
    step: 2,
    nextStep: 3,
    step2Token,
    heroData: {
      name: `${heroData.FIRSTNAME} ${heroData.LASTNAME}`,
      afpsn: heroData.AFPSN,
      controlNumber: heroData.CTRLNR,
      type: heroData.TYPE,
      dob: heroData.DOB
    },
    meta: {
      processingTime: `${processingTime}ms`,
      validUntil: new Date(Date.now() + 7200000).toISOString() // 2 hours
    }
  });
}

// STEP 3: Create account with email and password
async function handleStep3(req, res, startTime) {
  const { step2Token, email, password } = req.body;

  // Verify step 2 token
  let validationData;
  try {
    validationData = await getValidationToken(step2Token);
    if (validationData.step !== 2) {
      throw new Error('Invalid step 2 token');
    }
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: "Invalid or expired step 2 validation. Please start over.",
      code: 'INVALID_STEP2_TOKEN',
      step: 3,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  // Email and password validation
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: "Email and password are required",
      code: 'MISSING_CREDENTIALS',
      step: 3,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  if (!validator.isEmail(email)) {
    return res.status(400).json({
      success: false,
      error: "Please enter a valid email address",
      code: 'INVALID_EMAIL',
      step: 3,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  const filteredPassword = filterPassword(password);
  
  if (filteredPassword !== password) {
    return res.status(400).json({
      success: false,
      error: "Password contains invalid characters",
      code: 'INVALID_PASSWORD_CHARS',
      step: 3,
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
      step: 3,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

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
      step: 3,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  // Double-check hero record hasn't been claimed (race condition protection)
  const existingHeroAccount = await executeQuery(`
    SELECT u.id, u.email FROM users_tbl u 
    JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
    WHERE p.hero_ndx = ?`,
    [validationData.hero_ndx]
  );

  if (existingHeroAccount.length > 0) {
    return res.status(409).json({
      success: false,
      error: "An account already exists for this record",
      code: 'HERO_ACCOUNT_EXISTS',
      step: 3,
      processingTime: `${Date.now() - startTime}ms`
    });
  }

  // Create account using transaction
  const connection = await getConnection();
  
  try {
    await connection.beginTransaction();

    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(filteredPassword, saltRounds);
    
    // Create pensioner record
    const pensionerData = {
      hero_ndx: validationData.hero_ndx,
      type: validationData.type,
      bos: validationData.bos,
      b_type: validationData.b_type,
      principal_firstname: validationData.principal_first_name,
      principal_lastname: validationData.principal_last_name
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
    
    // Create user record
    const [userResult] = await connection.execute(
      `INSERT INTO users_tbl (pensioner_ndx, email, password_hash, status, created_at) 
       VALUES (?, ?, ?, 'UNV', NOW())`,
      [pensionerId, normalizedEmail, hashedPassword]
    );
    
    const userId = userResult.insertId;
    await connection.commit();

    const processingTime = Date.now() - startTime;
    logger.info(`Account creation successful for ${normalizedEmail} (${validationData.firstname} ${validationData.lastname}) in ${processingTime}ms`);

    return res.status(201).json({
      success: true,
      message: "Account created successfully! Welcome to the system.",
      step: 3,
      completed: true,
      user: {
        id: userId,
        email: normalizedEmail,
        pensioner_id: pensionerId,
        type: validationData.type,
        bos: pensionerData.bos,
        status: 'ACTIVE',
        validated_hero: {
          name: `${validationData.firstname} ${validationData.lastname}`,
          afpsn: validationData.afpsn,
          control_number: validationData.hero_ctrl_nr
        },
        ...(validationData.type === 'B' && {
          principal_info: {
            firstname: validationData.principal_first_name,
            lastname: validationData.principal_last_name,
            relationship: validationData.b_type
          }
        })
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
}

//  login 
router.post("/login", loginLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
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

    // Enhanced error categorization
    let errorResponse = {
      success: false,
      processingTime: `${processingTime}ms`,
      timestamp: new Date().toISOString()
    };

    if (error.code === 'PROTOCOL_CONNECTION_LOST') {
      errorResponse.error = "Database connection lost. Please try again.";
      errorResponse.code = 'CONNECTION_LOST';
      errorResponse.statusCode = 503;
    } else if (error.code === 'ECONNRESET') {
      errorResponse.error = "Database connection reset. Please try again.";
      errorResponse.code = 'CONNECTION_RESET';
      errorResponse.statusCode = 503;
    } else if (error.code === 'ETIMEDOUT') {
      errorResponse.error = "Database request timed out. Please try again.";
      errorResponse.code = 'TIMEOUT_ERROR';
      errorResponse.statusCode = 503;
    } else if (error.code === 'ECONNREFUSED') {
      errorResponse.error = "Unable to connect to database. Please try again later.";
      errorResponse.code = 'CONNECTION_REFUSED';
      errorResponse.statusCode = 503;
    } else if (error.code === 'ENOTFOUND') {
      errorResponse.error = "Database server not found. Please contact support.";
      errorResponse.code = 'SERVER_NOT_FOUND';
      errorResponse.statusCode = 503;
    } else {
      errorResponse.error = "Service temporarily unavailable. Please try again later.";
      errorResponse.code = 'SERVICE_ERROR';
      errorResponse.statusCode = 500;
    }

    res.status(errorResponse.statusCode).json(errorResponse);
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
    logger.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: "Logout failed",
      code: 'LOGOUT_ERROR'
    });
  }
});

module.exports = router;