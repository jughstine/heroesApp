const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const router = express.Router();
const { getConnection, executeQuery, healthCheck, testConnection, logger } = require('../config/database');
const nodemailer = require('nodemailer');
require('dotenv').config();

const TOKEN_EXPIRY_HOURS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, 
  port: parseInt(process.env.SMTP_PORT) || 2525, 
  secure: false,
  auth: {
    user: process.env.SMTP_USER, 
    pass: process.env.SMTP_PASSWORD 
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 30000, 
  greetingTimeout: 15000,   
  socketTimeout: 30000,     
  debug: process.env.NODE_ENV === 'development', 
  logger: process.env.NODE_ENV === 'development'
});

transporter.verify((error, success) => {
  if (error) {
    logger.error('SMTP configuration error:', error);
  } else {
    logger.info('SMTP server is ready to send emails');
  }
});

router.get("/", async (req, res) => {
    res.json({
        success: true,
        message: "Users API endpoint",
        availableEndpoints: [
            "POST /api/users/validate-identity",
            "POST /api/users/create-account",
            "POST /api/users/login",
            "GET /api/users/health",
            "POST /api/users/logout",
            "POST /api/users/forgot-password",
            "POST /api/users/verify-reset-code",
            "POST /api/users/reset-password",
            "POST /api/users/test-smtp"
        ]
    });
});

router.get("/test-smtp", async (req, res) => {
  try {
    console.log('SMTP Configuration:', {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      from: process.env.SMTP_FROM,
      hasPassword: !!process.env.SMTP_PASSWORD
    });

    // Test SMTP connection
    await transporter.verify();
    console.log('SMTP verification successful');
    
    // Test email sending
    const testMailOptions = {
      from: process.env.SMTP_FROM,
      to: 'parchie84@gmail.com',
      subject: 'SMTP Test from Cloud',
      text: 'This is a test email from your cloud environment',
      html: '<p>This is a test email from your <b>cloud environment</b></p>'
    };
    
    const result = await transporter.sendMail(testMailOptions);
    console.log('Email sent successfully:', result.messageId);
    
    res.json({
      success: true,
      message: 'SMTP configuration is working',
      messageId: result.messageId,
      from: process.env.SMTP_FROM
    });
    
  } catch (error) {
    console.error('SMTP test failed with details:', {
      message: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      response: error.response,
      command: error.command
    });
  }
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
                    { method: "POST", path: "/api/users/validate-step1", description: "Step 1: Validate pensioner type & AFPSN" },
                    { method: "POST", path: "/api/users/validate-step2", description: "Step 2: Validate personal information" },
                    { method: "POST", path: "/api/users/create-account", description: "Step 3: Create user account" },
                    { method: "POST", path: "/api/users/login", description: "signin" },
                    { method: "POST", path: "/api/users/forgot-password", description: "forgot password" },
                    { method: "POST", path: "/api/users/verify-reset-code", description: "verify code for reset password" },
                    { method: "POST", path: "/api/users/reset-password", description: "reset password" },
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

// ===== RATE LIMITERS =====
const identityLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many identity validation attempts. Please try again later.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const createAccountLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many account creation attempts. Please try again later.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many login attempts. Please try again after 15 minutes.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const pushTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
        success: false,
        error: 'Too many push token update attempts. Please try again later.',
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
    if (!hasSpecialChar) errors.push("Password must contain at least one special character");
    if (!noRepeatedChars) errors.push("Password cannot contain more than 2 repeated characters");
    if (!noCommonPatterns) errors.push("Password cannot be a common password");

    return {
        isValid: hasMinLength && hasMaxLength && hasNumber && hasLetter && hasSpecialChar && noRepeatedChars && noCommonPatterns,
        errors
    };
};

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
            timestamp: new Date().toISOString()
        });
    }
};

// ===== TOKEN MANAGEMENT =====
const generateValidationToken = (data) => {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, data };
};

const storeValidationToken = async (token, data, expiresInHours = TOKEN_EXPIRY_HOURS) => {
    try {
        const expiresAt = new Date(Date.now() + (expiresInHours * 60 * 60 * 1000));
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
            throw new Error('Invalid or expired validation token');
        }

        const tokenData = results[0].data;
        let parsedData;

        if (typeof tokenData === 'string') {
            parsedData = JSON.parse(tokenData);
        } else if (typeof tokenData === 'object' && tokenData !== null) {
            parsedData = tokenData;
        } else {
            throw new Error('Invalid token data type');
        }

        return parsedData;
    } catch (error) {
        if (error.message.includes('expired') || error.message.includes('Invalid')) {
            throw error;
        }
        logger.error('Database error in getValidationToken:', error);
        throw new Error('Token validation failed');
    }
};

const retryWithBackoff = async (operation, maxRetries = MAX_RETRY_ATTEMPTS) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            // Only retry on deadlock or lock wait timeout
            const isRetryable = error.code === 'ER_LOCK_DEADLOCK' || 
                               error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
                               error.errno === 1213 || 
                               error.errno === 1205;
            
            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }

            const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
            logger.warn(`Retrying operation (attempt ${attempt}/${maxRetries}) after ${delay}ms due to ${error.code}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
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
        }
    } catch (error) {
        logger.warn('Failed to cleanup expired tokens:', error.message);
    }
};

setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// SIGNUP 
const OFFICER_RANKS = ['2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL','COMMO', 'COL', 'CDR', 'BGEN', 'MGEN', 'LGEN'];

function normalizeAfpsnForMatching(afpsn) {
    if (!afpsn) return '';
    
    // Remove all non-numeric characters
    const numericOnly = afpsn.toString().replace(/\D/g, '');
    
    return numericOnly;
}

// ========================================
// SIGNUP
// ========================================

router.post("/validate-identity", identityLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { type, afpsn, bos, b_type, principal_first_name, principal_last_name, firstname, lastname, dob, claims_officer } = req.body;

        // Validation
        if (!type || !afpsn || !firstname || !lastname || !dob) {
            return res.status(400).json({
                success: false,
                error: "Type, AFP Serial Number, name, and date of birth are required",
                code: 'MISSING_REQUIRED_FIELDS'
            });
        }

        if (!['P', 'B'].includes(type)) {
            return res.status(400).json({ success: false, error: "Invalid pensioner type", code: 'INVALID_TYPE' });
        }

        if (type === 'P' && !bos) {
            return res.status(400).json({ success: false, error: "Branch of service required", code: 'MISSING_BOS' });
        }

        if (type === 'B' && (!b_type || !principal_first_name || !principal_last_name)) {
            return res.status(400).json({ success: false, error: "Beneficiary information required", code: 'MISSING_BENEFICIARY_INFO' });
        }

        // Normalize inputs
        const normalizedAfpsn = afpsn.trim().toUpperCase();
        const normalizedAfpsnNumeric = normalizeAfpsnForMatching(normalizedAfpsn);
        const normalizedFirstname = firstname.trim().toUpperCase();
        const normalizedLastname = lastname.trim().toUpperCase();

        // Debug logging
        logger.info('AFPSN Search:', { 
            original: afpsn, 
            normalized: normalizedAfpsn, 
            numeric: normalizedAfpsnNumeric,
            type: type 
        });

        // === BENEFICIARY LOGIC (Type B) ===
        if (type === 'B') {
            const normalizedPrincipalFirstname = principal_first_name.trim().toUpperCase();
            const normalizedPrincipalLastname = principal_last_name.trim().toUpperCase();

            // Age validation for CH (Child) and SB (Sibling) - moved to top
            if (['CH', 'SB'].includes(b_type)) {
                const beneficiaryDob = new Date(dob);
                const today = new Date();
                let age = today.getFullYear() - beneficiaryDob.getFullYear();
                const monthDiff = today.getMonth() - beneficiaryDob.getMonth();
                
                if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < beneficiaryDob.getDate())) {
                    age--;
                }

                if (age > 20) {
                    return res.status(400).json({
                        success: false,
                        error: `${b_type === 'CH' ? 'Child' : 'Sibling'} beneficiaries must be 20 years old or below`,
                        code: 'AGE_LIMIT_EXCEEDED',
                        details: {
                            currentAge: age,
                            maxAge: 20,
                            beneficiaryType: b_type
                        }
                    });
                }
            }

            // CRITICAL FIX: For Legal Beneficiary Applications, FIRST verify the principal pensioner exists with TYPE = 'P'
            // The AFPSN provided should belong to a Type P principal, NOT a Type B beneficiary
            let principalRecords;
            try {
                principalRecords = await executeQuery(
                    `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, PENRANK, ACRANK
                    FROM test_table
                    WHERE REGEXP_REPLACE(UPPER(TRIM(AFPSN)), '[^0-9]', '') = ?
                    AND UPPER(TRIM(FIRSTNAME)) = ?
                    AND UPPER(TRIM(LASTNAME)) = ?
                    AND TYPE = 'P'`,
                    [normalizedAfpsnNumeric, normalizedPrincipalFirstname, normalizedPrincipalLastname]
                );
            } catch (regexpError) {
                // Fallback for MySQL < 8.0
                logger.warn('REGEXP_REPLACE not supported, using REPLACE fallback');
                principalRecords = await executeQuery(
                    `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, PENRANK, ACRANK
                    FROM test_table
                    WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ?
                    AND UPPER(TRIM(FIRSTNAME)) = ?
                    AND UPPER(TRIM(LASTNAME)) = ?
                    AND TYPE = 'P'`,
                    [normalizedAfpsnNumeric, normalizedPrincipalFirstname, normalizedPrincipalLastname]
                );
            }

            if (principalRecords.length === 0) {
                logger.warn('Principal pensioner not found:', { 
                    afpsn: normalizedAfpsn, 
                    name: `${normalizedPrincipalFirstname} ${normalizedPrincipalLastname}`,
                    type: 'P'
                });
                return res.status(401).json({ 
                    success: false, 
                    error: "Principal pensioner not found in active records. The AFPSN must belong to a Type P (Principal) pensioner.", 
                    code: 'PRINCIPAL_NOT_FOUND' 
                });
            }

            if (principalRecords.length > 1) {
                return res.status(409).json({ 
                    success: false, 
                    error: "Multiple principal records found", 
                    code: 'DUPLICATE_PRINCIPAL_RECORDS' 
                });
            }

            const principalData = principalRecords[0];
            const penRank = principalData.PENRANK?.trim().toUpperCase();
            const isOfficer = penRank ? OFFICER_RANKS.includes(penRank) : false;

            // Officer validation for principal
            if (claims_officer && !isOfficer) {
                return res.status(400).json({ 
                    success: false, 
                    error: `Principal rank mismatch: ${penRank}`, 
                    code: 'INVALID_OFFICER_CLAIM', 
                    rank: penRank 
                });
            }
            if (!claims_officer && isOfficer) {
                return res.status(400).json({ 
                    success: false, 
                    error: `Principal pensioner is an officer (${penRank})`, 
                    code: 'MISSING_OFFICER_CLAIM', 
                    rank: penRank 
                });
            }

            // NOW check if this specific beneficiary already exists in test_table (active payroll)
            // This checks using the principal's AFPSN that we just validated
            let existingBeneficiaryInTestTable;
            try {
                existingBeneficiaryInTestTable = await executeQuery(
                    `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, PENRANK, ACRANK
                    FROM test_table
                    WHERE UPPER(TRIM(FIRSTNAME)) = ?
                    AND UPPER(TRIM(LASTNAME)) = ?
                    AND DATE(DOB) = DATE(?)
                    AND REGEXP_REPLACE(UPPER(TRIM(AFPSN)), '[^0-9]', '') = ?
                    AND TYPE = 'B'`,
                    [normalizedFirstname, normalizedLastname, dob, normalizedAfpsnNumeric]
                );
            } catch (regexpError) {
                existingBeneficiaryInTestTable = await executeQuery(
                    `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, PENRANK, ACRANK
                    FROM test_table
                    WHERE UPPER(TRIM(FIRSTNAME)) = ?
                    AND UPPER(TRIM(LASTNAME)) = ?
                    AND DATE(DOB) = DATE(?)
                    AND REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ?
                    AND TYPE = 'B'`,
                    [normalizedFirstname, normalizedLastname, dob, normalizedAfpsnNumeric]
                );
            }

            // If beneficiary exists in test_table as Type B with the SAME AFPSN, treat them like an active pensioner
            if (existingBeneficiaryInTestTable.length > 0) {
                const heroData = existingBeneficiaryInTestTable[0];
                
                // Check for existing account
                let existingAccount;
                try {
                    existingAccount = await executeQuery(
                        `SELECT u.id, u.status, h.FIRSTNAME, h.LASTNAME, h.AFPSN
                        FROM users_tbl u 
                        JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
                        LEFT JOIN test_table h ON p.hero_ndx = h.NDX
                        WHERE p.hero_ndx = ?
                        AND p.source_table = 'test_table'
                        AND p.type = 'B'
                        AND u.status NOT IN ('DEL')
                        FOR UPDATE`,
                        [heroData.NDX]
                    );
                } catch (error) {
                    logger.error('Error checking existing account:', error);
                    existingAccount = [];
                }

                if (existingAccount.length > 0) {
                    logger.warn(`Duplicate account attempt for active beneficiary: ${normalizedFirstname} ${normalizedLastname}`);
                    return res.status(409).json({ 
                        success: false, 
                        error: "An account already exists for this beneficiary", 
                        code: 'ACCOUNT_EXISTS',
                        details: {
                            afpsn: normalizedAfpsn,
                            name: `${normalizedFirstname} ${normalizedLastname}`
                        }
                    });
                }

                // Generate token for active beneficiary (from test_table)
                const tokenData = {
                    type: 'B',
                    afpsn: normalizedAfpsn,
                    bos: null,
                    b_type,
                    principal_afpsn: normalizedAfpsn,
                    principal_first_name: normalizedPrincipalFirstname,
                    principal_last_name: normalizedPrincipalLastname,
                    principal_ndx: principalData.NDX,
                    firstname: normalizedFirstname,
                    lastname: normalizedLastname,
                    dob,
                    hero_ndx: heroData.NDX,
                    penRank,
                    acRank: heroData.ACRANK,
                    isOfficer,
                    account_status: 'active',
                    source_table: 'test_table',
                    validated_at: new Date().toISOString()
                };

                const { token } = generateValidationToken(tokenData);
                const identityToken = await storeValidationToken(token, tokenData);

                return res.json({
                    success: true,
                    message: "Active beneficiary identity verified successfully",
                    identityToken,
                    heroData: {
                        name: `${heroData.FIRSTNAME} ${heroData.LASTNAME}`,
                        afpsn: heroData.AFPSN,
                        type: 'B',
                        beneficiaryType: b_type,
                        dob: heroData.DOB
                    },
                    data: {
                        type: 'B',
                        afpsn: normalizedAfpsn,
                        rank: penRank,
                        isOfficer,
                        account_status: 'active',
                        source_table: 'test_table'
                    },
                    meta: {
                        processingTime: `${Date.now() - startTime}ms`,
                        validUntil: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 3600000).toISOString()
                    }
                });
            }

            // Check for existing beneficiary account in beneficiaries_table
            let existingBeneficiary;
            try {
                existingBeneficiary = await executeQuery(
                    `SELECT u.id, u.status, b.FIRSTNAME, b.LASTNAME, b.AFPSN
                    FROM users_tbl u 
                    JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
                    LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX
                    WHERE UPPER(TRIM(b.FIRSTNAME)) = ?
                    AND UPPER(TRIM(b.LASTNAME)) = ?
                    AND DATE(b.DOB) = DATE(?)
                    AND UPPER(TRIM(p.principal_firstname)) = ?
                    AND UPPER(TRIM(p.principal_lastname)) = ?
                    AND REGEXP_REPLACE(UPPER(TRIM(p.principal_afpsn)), '[^0-9]', '') = ?
                    AND p.b_type = ?
                    AND p.type = 'B'
                    AND p.source_table = 'beneficiaries_table'
                    AND u.status NOT IN ('DEL')
                    FOR UPDATE`,
                    [
                        normalizedFirstname,
                        normalizedLastname,
                        dob,
                        normalizedPrincipalFirstname,
                        normalizedPrincipalLastname,
                        normalizedAfpsnNumeric,
                        b_type
                    ]
                );
            } catch (regexpError) {
                existingBeneficiary = await executeQuery(
                    `SELECT u.id, u.status, b.FIRSTNAME, b.LASTNAME, b.AFPSN
                    FROM users_tbl u 
                    JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
                    LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX
                    WHERE UPPER(TRIM(b.FIRSTNAME)) = ?
                    AND UPPER(TRIM(b.LASTNAME)) = ?
                    AND DATE(b.DOB) = DATE(?)
                    AND UPPER(TRIM(p.principal_firstname)) = ?
                    AND UPPER(TRIM(p.principal_lastname)) = ?
                    AND REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(p.principal_afpsn)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ?
                    AND p.b_type = ?
                    AND p.type = 'B'
                    AND p.source_table = 'beneficiaries_table'
                    AND u.status NOT IN ('DEL')
                    FOR UPDATE`,
                    [
                        normalizedFirstname,
                        normalizedLastname,
                        dob,
                        normalizedPrincipalFirstname,
                        normalizedPrincipalLastname,
                        normalizedAfpsnNumeric,
                        b_type
                    ]
                );
            }

            if (existingBeneficiary.length > 0) {
                logger.warn(`Duplicate beneficiary account attempt: ${normalizedFirstname} ${normalizedLastname}`);
                return res.status(409).json({ 
                    success: false, 
                    error: "An account already exists for this beneficiary", 
                    code: 'ACCOUNT_EXISTS',
                    details: {
                        beneficiary: `${normalizedFirstname} ${normalizedLastname}`,
                        principal: `${normalizedPrincipalFirstname} ${normalizedPrincipalLastname}`,
                        afpsn: normalizedAfpsn
                    }
                });
            }

            // Generate token for beneficiary with principal's reference data
            const tokenData = {
                type: 'B',
                afpsn: normalizedAfpsn,
                bos: null,
                b_type,
                principal_ndx: principalData.NDX,
                principal_afpsn: principalData.AFPSN,
                principal_first_name: normalizedPrincipalFirstname,
                principal_last_name: normalizedPrincipalLastname,
                firstname: normalizedFirstname,
                lastname: normalizedLastname,
                dob,
                hero_ndx: null,
                penRank,
                acRank: principalData.ACRANK,
                isOfficer,
                account_status: 'beneficiary_application',
                source_table: 'beneficiaries_table',
                validated_at: new Date().toISOString()
            };

            const { token } = generateValidationToken(tokenData);
            const identityToken = await storeValidationToken(token, tokenData);

            return res.json({
                success: true,
                message: "Beneficiary identity verified successfully",
                identityToken,
                heroData: {
                    beneficiaryName: `${normalizedFirstname} ${normalizedLastname}`,
                    principalName: `${principalData.FIRSTNAME} ${principalData.LASTNAME}`,
                    principalAfpsn: principalData.AFPSN,
                    type: 'B',
                    beneficiaryType: b_type,
                    beneficiaryDob: dob
                },
                data: {
                    type: 'B',
                    principalAfpsn: normalizedAfpsn,
                    rank: penRank,
                    isOfficer,
                    account_status: 'beneficiary_application',
                    source_table: 'beneficiaries_table'
                },
                meta: {
                    processingTime: `${Date.now() - startTime}ms`,
                    validUntil: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 3600000).toISOString()
                }
            });
        }

        // === PRINCIPAL LOGIC (Type P) - Active Pensioner or Resumption Application ===
        let detectedTable = null;
        let afpsnRecords = null;
        let penRank = null;

        // Try active table first (test_table)
        try {
            afpsnRecords = await executeQuery(
                `SELECT COUNT(*) as count, PENRANK, AFPSN 
                 FROM test_table
                 WHERE REGEXP_REPLACE(UPPER(TRIM(AFPSN)), '[^0-9]', '') = ? 
                 AND TYPE = ? 
                 GROUP BY PENRANK, AFPSN`,
                [normalizedAfpsnNumeric, type]
            );

            if (afpsnRecords.length > 0) {
                detectedTable = 'test_table';
                penRank = afpsnRecords[0].PENRANK?.trim().toUpperCase();
                logger.info('Found in active table:', { afpsn: afpsnRecords[0].AFPSN, rank: penRank });
            }
        } catch (regexpError) {
            logger.warn('REGEXP_REPLACE not supported, using REPLACE fallback');
            
            afpsnRecords = await executeQuery(
                `SELECT COUNT(*) as count, PENRANK, AFPSN 
                 FROM test_table
                 WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ? 
                 AND TYPE = ? 
                 GROUP BY PENRANK, AFPSN`,
                [normalizedAfpsnNumeric, type]
            );

            if (afpsnRecords.length > 0) {
                detectedTable = 'test_table';
                penRank = afpsnRecords[0].PENRANK?.trim().toUpperCase();
            }
        }

        // Try resumption table if not found (test_res_table)
        if (!detectedTable) {
            try {
                afpsnRecords = await executeQuery(
                    `SELECT COUNT(*) as count, PENRANK, AFPSN 
                     FROM test_res_table
                     WHERE REGEXP_REPLACE(UPPER(TRIM(AFPSN)), '[^0-9]', '') = ? 
                     AND TYPE = ? 
                     GROUP BY PENRANK, AFPSN`,
                    [normalizedAfpsnNumeric, type]
                );

                if (afpsnRecords.length > 0) {
                    detectedTable = 'test_res_table';
                    penRank = afpsnRecords[0].PENRANK?.trim().toUpperCase();
                    logger.info('Found in resumption table:', { afpsn: afpsnRecords[0].AFPSN, rank: penRank });
                }
            } catch (regexpError) {
                afpsnRecords = await executeQuery(
                    `SELECT COUNT(*) as count, PENRANK, AFPSN 
                     FROM test_res_table
                     WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ? 
                     AND TYPE = ? 
                     GROUP BY PENRANK, AFPSN`,
                    [normalizedAfpsnNumeric, type]
                );

                if (afpsnRecords.length > 0) {
                    detectedTable = 'test_res_table';
                    penRank = afpsnRecords[0].PENRANK?.trim().toUpperCase();
                }
            }
        }

        if (!detectedTable) {
            logger.warn('AFPSN not found:', { afpsn: normalizedAfpsn, numeric: normalizedAfpsnNumeric, type });
            return res.status(401).json({ 
                success: false, 
                error: "AFP Serial Number not found in our records", 
                code: 'AFPSN_NOT_FOUND' 
            });
        }

        const account_status = detectedTable === 'test_table' ? 'active' : 'resumption';
        const isOfficer = penRank ? OFFICER_RANKS.includes(penRank) : false;

        // Officer validation
        if (claims_officer && !isOfficer) {
            return res.status(400).json({ 
                success: false, 
                error: `Rank mismatch: ${penRank}`, 
                code: 'INVALID_OFFICER_CLAIM', 
                rank: penRank 
            });
        }
        if (!claims_officer && isOfficer) {
            return res.status(400).json({ 
                success: false, 
                error: `You are an officer (${penRank})`, 
                code: 'MISSING_OFFICER_CLAIM', 
                rank: penRank 
            });
        }

        // Verify personal information
        let heroes;
        try {
            heroes = await executeQuery(
                `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, PENRANK, ACRANK
                FROM ${detectedTable}
                WHERE UPPER(TRIM(FIRSTNAME)) = ? 
                AND UPPER(TRIM(LASTNAME)) = ? 
                AND DATE(DOB) = DATE(?) 
                AND REGEXP_REPLACE(UPPER(TRIM(AFPSN)), '[^0-9]', '') = ?
                AND TYPE = ?`,
                [normalizedFirstname, normalizedLastname, dob, normalizedAfpsnNumeric, type]
            );
        } catch (regexpError) {
            heroes = await executeQuery(
                `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, PENRANK, ACRANK
                FROM ${detectedTable}
                WHERE UPPER(TRIM(FIRSTNAME)) = ? 
                AND UPPER(TRIM(LASTNAME)) = ? 
                AND DATE(DOB) = DATE(?) 
                AND REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ?
                AND TYPE = ?`,
                [normalizedFirstname, normalizedLastname, dob, normalizedAfpsnNumeric, type]
            );
        }

        if (heroes.length === 0) {
            return res.status(401).json({ 
                success: false, 
                error: "Personal information mismatch", 
                code: 'PERSONAL_INFO_MISMATCH' 
            });
        }
        if (heroes.length > 1) {
            return res.status(409).json({ 
                success: false, 
                error: "Multiple records found", 
                code: 'DUPLICATE_RECORDS' 
            });
        }

        const heroData = heroes[0];

        // Check for existing account
        let existingAccount;
        try {
            existingAccount = await executeQuery(
                `SELECT u.id, u.status, h.FIRSTNAME, h.LASTNAME, h.AFPSN
                FROM users_tbl u 
                JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
                LEFT JOIN ${detectedTable} h ON p.hero_ndx = h.NDX
                WHERE REGEXP_REPLACE(UPPER(TRIM(h.AFPSN)), '[^0-9]', '') = ?
                AND UPPER(TRIM(h.FIRSTNAME)) = ?
                AND UPPER(TRIM(h.LASTNAME)) = ?
                AND p.source_table = ?
                AND u.status NOT IN ('DEL')
                FOR UPDATE`,
                [normalizedAfpsnNumeric, normalizedFirstname, normalizedLastname, detectedTable]
            );
        } catch (regexpError) {
            existingAccount = await executeQuery(
                `SELECT u.id, u.status, h.FIRSTNAME, h.LASTNAME, h.AFPSN
                FROM users_tbl u 
                JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
                LEFT JOIN ${detectedTable} h ON p.hero_ndx = h.NDX
                WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(h.AFPSN)), 'O-', ''), 'X-', ''), ' ', ''), '-', '') = ?
                AND UPPER(TRIM(h.FIRSTNAME)) = ?
                AND UPPER(TRIM(h.LASTNAME)) = ?
                AND p.source_table = ?
                AND u.status NOT IN ('DEL')
                FOR UPDATE`,
                [normalizedAfpsnNumeric, normalizedFirstname, normalizedLastname, detectedTable]
            );
        }

        if (existingAccount.length > 0) {
            logger.warn(`Duplicate account attempt: ${normalizedAfpsn} - ${normalizedFirstname} ${normalizedLastname}`);
            return res.status(409).json({ 
                success: false, 
                error: "An account already exists for this person", 
                code: 'ACCOUNT_EXISTS',
                details: {
                    afpsn: normalizedAfpsn,
                    name: `${normalizedFirstname} ${normalizedLastname}`
                }
            });
        }

        // Generate token
        const tokenData = {
            type, 
            afpsn: normalizedAfpsn, 
            bos: type === 'P' ? bos?.trim().toUpperCase() : null,
            b_type: null,
            principal_first_name: null,
            principal_last_name: null,
            firstname: normalizedFirstname, 
            lastname: normalizedLastname, 
            dob,
            hero_ndx: heroData.NDX, 
            penRank, 
            acRank: heroData.ACRANK, 
            isOfficer, 
            account_status, 
            source_table: detectedTable,
            validated_at: new Date().toISOString()
        };

        const { token } = generateValidationToken(tokenData);
        const identityToken = await storeValidationToken(token, tokenData);

        res.json({
            success: true,
            message: "Identity verified successfully",
            identityToken,
            heroData: {
                name: `${heroData.FIRSTNAME} ${heroData.LASTNAME}`,
                afpsn: heroData.AFPSN,
                type: heroData.TYPE,
                dob: heroData.DOB
            },
            data: { 
                type, 
                afpsn: normalizedAfpsn, 
                rank: penRank, 
                isOfficer, 
                account_status, 
                source_table: detectedTable 
            },
            meta: { 
                processingTime: `${Date.now() - startTime}ms`, 
                validUntil: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 3600000).toISOString() 
            }
        });

    } catch (error) {
        logger.error("Identity validation error:", error);
        res.status(500).json({ 
            success: false, 
            error: "Identity validation failed", 
            code: 'IDENTITY_VALIDATION_ERROR',
            details: error.message 
        });
    }
});

router.post("/create-account", createAccountLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();
    let connection = null;

    try {
        const { identityToken, email, password } = req.body;

        if (!identityToken || !email || !password) {
            return res.status(400).json({ success: false, error: "Missing required fields", code: 'MISSING_REQUIRED_FIELDS' });
        }

        // Validate token
        let validationData;
        try {
            validationData = await getValidationToken(identityToken);
            if (!validationData) throw new Error('Invalid validation data');
        } catch (error) {
            return res.status(400).json({ success: false, error: "Invalid or expired token", code: 'INVALID_IDENTITY_TOKEN' });
        }

        // Validate email
        if (!validator.isEmail(email)) {
            return res.status(400).json({ success: false, error: "Invalid email format", code: 'INVALID_EMAIL_FORMAT' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        const existingEmail = await executeQuery(
            'SELECT id FROM users_tbl WHERE email = ? FOR UPDATE',
            [normalizedEmail]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({ success: false, error: "Email already exists", code: 'EMAIL_ALREADY_EXISTS' });
        }

        // Validate password
        const passwordValidation = validatePasswordStrength(password);
        if (!passwordValidation.isValid) {
            return res.status(400).json({
                success: false,
                error: "Weak password",
                details: passwordValidation.errors,
                code: 'PASSWORD_TOO_WEAK'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        // Get connection
        connection = await getConnection();

        await retryWithBackoff(async () => {
            try {
                await connection.execute('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await connection.beginTransaction();

                let pensionerId;
                let beneficiaryNdx = null;

                // === BENEFICIARY (Type B) ===
// === BENEFICIARY (Type B) === - FIXED VERSION
if (validationData.type === 'B') {
    
    // Check if this is an active beneficiary from test_table or a new application
    if (validationData.source_table === 'test_table') {
        // Active beneficiary from test_table (like active pensioner)
        const [heroCheck] = await connection.execute(
            `SELECT p.id FROM pensioners_tbl p 
             WHERE p.hero_ndx = ? AND p.source_table = 'test_table' AND p.type = 'B'
             FOR UPDATE`,
            [validationData.hero_ndx]
        );

        if (heroCheck.length > 0) {
            throw { code: 'RECORD_ALREADY_CLAIMED', statusCode: 409, message: 'Account already exists for this beneficiary' };
        }

        // Insert pensioner record pointing to test_table
        const [pensionerResult] = await connection.execute(
            `INSERT INTO pensioners_tbl 
             (hero_ndx, source_table, type, bos, b_type, 
              principal_afpsn, principal_firstname, principal_lastname, account_status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                validationData.hero_ndx,
                'test_table',
                'B',
                null, // bos
                validationData.b_type || null,
                validationData.principal_afpsn || null, // Add this
                validationData.principal_first_name || null,
                validationData.principal_last_name || null,
                'active'
            ]
        );

        pensionerId = pensionerResult.insertId;
        if (!pensionerId) throw new Error('Failed to create pensioner record');

    } else {
        // New beneficiary application - insert into beneficiaries_table
        const [existingBeneficiary] = await connection.execute(
            `SELECT p.id FROM pensioners_tbl p
             LEFT JOIN beneficiaries_table b ON p.hero_ndx = b.NDX
             WHERE UPPER(TRIM(b.FIRSTNAME)) = ?
             AND UPPER(TRIM(b.LASTNAME)) = ?
             AND DATE(b.DOB) = DATE(?)
             AND UPPER(TRIM(p.principal_firstname)) = ?
             AND UPPER(TRIM(p.principal_lastname)) = ?
             AND p.b_type = ?
             AND p.type = 'B'
             AND p.source_table = 'beneficiaries_table'
             FOR UPDATE`,
            [
                validationData.firstname,
                validationData.lastname,
                validationData.dob,
                validationData.principal_first_name,
                validationData.principal_last_name,
                validationData.b_type
            ]
        );

        if (existingBeneficiary.length > 0) {
            throw { code: 'RECORD_ALREADY_CLAIMED', statusCode: 409, message: 'Account already exists for this beneficiary' };
        }

        // FIXED: Insert beneficiary into beneficiaries_table with proper null handling
        const [beneficiaryResult] = await connection.execute(
            `INSERT INTO beneficiaries_table 
             (FIRSTNAME, LASTNAME, DOB, AFPSN, TYPE, PENRANK, ACRANK) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                validationData.firstname,
                validationData.lastname,
                validationData.dob,
                validationData.afpsn || validationData.principal_afpsn, // Use principal AFPSN if afpsn is not set
                'B',
                validationData.penRank || null, // Explicitly handle null
                validationData.acRank || null    // Explicitly handle null
            ]
        );

        beneficiaryNdx = beneficiaryResult.insertId;
        if (!beneficiaryNdx) throw new Error('Failed to create beneficiary record');

        // FIXED: Insert pensioner record with proper null handling
        const [pensionerResult] = await connection.execute(
            `INSERT INTO pensioners_tbl 
             (hero_ndx, source_table, type, bos, b_type, 
              principal_afpsn, principal_firstname, principal_lastname, 
             principal_ndx, account_status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                beneficiaryNdx,
                'beneficiaries_table',
                'B',
                null, // bos is always null for beneficiaries
                validationData.b_type || null,
                validationData.principal_afpsn || validationData.afpsn, // Ensure we have principal AFPSN
                validationData.principal_first_name || null,
                validationData.principal_last_name || null,
                validationData.principal_ndx || null,     // Explicitly handle null
                'beneficiary_application'
            ]
        );

        pensionerId = pensionerResult.insertId;
        if (!pensionerId) throw new Error('Failed to create pensioner record');
    }

} else {
    // === PRINCIPAL (Type P) - Use existing hero_ndx from test_table or test_res_table ===
    const [heroCheck] = await connection.execute(
        `SELECT p.id FROM pensioners_tbl p 
         WHERE p.hero_ndx = ? AND p.source_table = ? AND p.type = 'P'
         FOR UPDATE`,
        [validationData.hero_ndx, validationData.source_table]
    );

    if (heroCheck.length > 0) {
        throw { code: 'RECORD_ALREADY_CLAIMED', statusCode: 409, message: 'Account already exists for this record' };
    }

    const [pensionerResult] = await connection.execute(
        `INSERT INTO pensioners_tbl (hero_ndx, source_table, type, bos, account_status) 
         VALUES (?, ?, ?, ?, ?)`,
        [
            validationData.hero_ndx,
            validationData.source_table,
            'P',
            validationData.bos || null,
            validationData.account_status
        ]
    );

    pensionerId = pensionerResult.insertId;
    if (!pensionerId) throw new Error('Failed to create pensioner');
}
                // Determine initial user status
                let initialUserStatus;
                if (validationData.type === 'B') {
                    if (validationData.source_table === 'test_table') {
                        initialUserStatus = 'TAG'; // Active beneficiary, same as active pensioner
                    } else {
                        initialUserStatus = 'AFB'; // Awaiting approval for new beneficiary application
                    }
                } else if (validationData.account_status === 'resumption') {
                    initialUserStatus = 'AFR'; // Awaiting approval for resumption
                } else {
                    initialUserStatus = 'TAG'; // Tagged for active pensioners
                }

                // Insert user
                const [userResult] = await connection.execute(
                    `INSERT INTO users_tbl (pensioner_ndx, email, password_hash, status, tagged_at) 
                     VALUES (?, ?, ?, ?, NOW())`,
                    [pensionerId, normalizedEmail, hashedPassword, initialUserStatus]
                );

                const userId = userResult.insertId;
                if (!userId) throw new Error('Failed to create user');

                // Delete token
                await connection.execute('DELETE FROM signup_tokens WHERE token = ?', [identityToken]);

                await connection.commit();

                return {
                    userId,
                    pensionerId,
                    beneficiaryNdx,
                    email: normalizedEmail,
                    status: initialUserStatus,
                    account_status: validationData.account_status,
                    type: validationData.type
                };

            } catch (error) {
                // Rollback on any error
                try {
                    await connection.rollback();
                } catch (rollbackError) {
                    logger.error('Rollback failed:', rollbackError);
                }
                throw error;
            }
        }).then(result => {
            let message;
            if (validationData.type === 'B') {
                if (validationData.source_table === 'test_table') {
                    message = "Active beneficiary account created successfully";
                } else {
                    message = "Beneficiary application submitted. Pending approval.";
                }
            } else if (validationData.account_status === 'resumption') {
                message = "Account created. Pending approval for resumption.";
            } else {
                message = "Account created successfully";
            }

            res.status(201).json({
                success: true,
                message,
                data: result,
                meta: { 
                    processingTime: `${Date.now() - startTime}ms`, 
                    timestamp: new Date().toISOString() 
                }
            });
        });

    } catch (error) {
        logger.error("Account creation error:", error);

        let statusCode = 500;
        let errorCode = 'ACCOUNT_CREATION_FAILED';
        let errorMessage = "Account creation failed";

        if (error.code === 'ER_DUP_ENTRY') {
            statusCode = 409;
            errorCode = 'DUPLICATE_ENTRY';
            errorMessage = "Account already exists";
        } else if (error.code === 'RECORD_ALREADY_CLAIMED') {
            statusCode = error.statusCode;
            errorCode = error.code;
            errorMessage = error.message;
        } else if (error.code === 'ER_LOCK_DEADLOCK') {
            statusCode = 409;
            errorCode = 'CONCURRENT_REQUEST';
            errorMessage = "Another registration in progress. Please try again.";
        } else if (error.code === 'ER_CANT_CHANGE_TX_CHARACTERISTICS') {
            statusCode = 500;
            errorCode = 'TRANSACTION_ERROR';
            errorMessage = "Database transaction error. Please try again.";
        }

        res.status(statusCode).json({
            success: false,
            error: errorMessage,
            code: errorCode,
            processingTime: `${Date.now() - startTime}ms`
        });

    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (e) {
                logger.error('Connection release failed:', e);
            }
        }
    }
});

// ========================================
// LOGIN
// ========================================
router.post("/login", loginLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: "Email and password required", code: 'MISSING_CREDENTIALS' });
        }

        if (!validator.isEmail(email)) {
            return res.status(400).json({ success: false, error: "Invalid email", code: 'INVALID_EMAIL' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        const users = await executeQuery(`
            SELECT 
                u.id AS user_id,
                u.email,
                u.password_hash,
                u.status AS user_status,
                p.id AS pensioner_id,
                p.type,
                p.bos,
                p.source_table,
                p.account_status,
                COALESCE(h.FIRSTNAME, h2.FIRSTNAME, h3.FIRSTNAME) AS FIRSTNAME,
                COALESCE(h.LASTNAME, h2.LASTNAME, h3.LASTNAME) AS LASTNAME,
                COALESCE(h.AFPSN, h2.AFPSN, h3.AFPSN) AS AFPSN
            FROM users_tbl u
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
            LEFT JOIN test_table h 
                ON p.hero_ndx = h.NDX AND p.source_table = 'test_table'
            LEFT JOIN test_res_table h2 
                ON p.hero_ndx = h2.NDX AND p.source_table = 'test_res_table'
            LEFT JOIN beneficiaries_table h3 
                ON p.hero_ndx = h3.NDX AND p.source_table = 'beneficiaries_table'
            WHERE u.email = ?
            LOCK IN SHARE MODE
        `, [normalizedEmail]);

        if (users.length === 0) {
            return res.status(401).json({ success: false, error: "Invalid credentials", code: 'INVALID_CREDENTIALS' });
        }

        const user = users[0];

        if (user.user_status === 'SUS') {
            return res.status(403).json({ success: false, error: "Account suspended", code: 'ACCOUNT_SUSPENDED' });
        }

        // Verify password
        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, error: "Invalid credentials", code: 'INVALID_CREDENTIALS' });
        }

        // Update last login (non-blocking)
        executeQuery('UPDATE users_tbl SET last_login = NOW() WHERE id = ?', [user.user_id])
            .catch(err => logger.warn('Failed to update last_login:', err));

        res.json({
            success: true,
            message: "Login successful",
            user: {
                id: user.user_id,
                email: user.email,
                pensioner_id: user.pensioner_id,
                type: user.type,
                status: 'ACTIVE',
                account_status: user.account_status,
                validated_hero: {
                    name: `${user.FIRSTNAME} ${user.LASTNAME}`,
                    afpsn: user.AFPSN,
                }
            },
            meta: { processingTime: `${Date.now() - startTime}ms`, loginTime: new Date().toISOString() }
        });

    } catch (error) {
        logger.error("Login error:", error);
        res.status(500).json({ success: false, error: "Login failed", code: 'SERVICE_ERROR' });
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

// PROFILE ROUTES

// Rate limiter for profile updates
const profileUpdateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: {
        success: false,
        error: 'Too many update attempts. Please try again later.',
        code: 'RATE_LIMITED'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Update Email Endpoint
router.put("/update-email/:userId", profileUpdateLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { userId } = req.params;
        const { email } = req.body;

        // Validation
        if (!email) {
            return res.status(400).json({
                success: false,
                error: "Email is required",
                code: 'MISSING_EMAIL',
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

        // Check if user exists
        const userCheck = await executeQuery(
            'SELECT id, email FROM users_tbl WHERE id = ? LIMIT 1',
            [userId]
        );

        if (userCheck.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                code: 'USER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Check if new email already exists (excluding current user)
        const emailExists = await executeQuery(
            'SELECT id FROM users_tbl WHERE email = ? AND id != ? LIMIT 1',
            [normalizedEmail, userId]
        );

        if (emailExists.length > 0) {
            return res.status(409).json({
                success: false,
                error: "This email is already in use by another account",
                code: 'EMAIL_EXISTS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Update email
        await executeQuery(
            'UPDATE users_tbl SET email = ?, updated_at = NOW() WHERE id = ?',
            [normalizedEmail, userId]
        );

        const processingTime = Date.now() - startTime;
        res.json({
            success: true,
            message: "Email updated successfully",
            data: {
                email: normalizedEmail
            },
            meta: {
                processingTime: `${processingTime}ms`,
                updatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error("Email update error:", error);

        res.status(500).json({
            success: false,
            error: "Failed to update email. Please try again.",
            code: 'EMAIL_UPDATE_ERROR',
            processingTime: `${processingTime}ms`
        });
    }
});

// Update Password Endpoint
router.put("/update-password/:userId", profileUpdateLimiter, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { userId } = req.params;
        const { currentPassword, newPassword } = req.body;

        // Validation
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: "Current password and new password are required",
                code: 'MISSING_PASSWORDS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Filter and validate new password
        const filteredNewPassword = filterPassword(newPassword);

        if (filteredNewPassword !== newPassword) {
            return res.status(400).json({
                success: false,
                error: "New password contains invalid characters",
                code: 'INVALID_PASSWORD_CHARS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const passwordValidation = validatePasswordStrength(filteredNewPassword);
        if (!passwordValidation.isValid) {
            return res.status(400).json({
                success: false,
                error: "New password does not meet security requirements",
                details: passwordValidation.errors,
                code: 'WEAK_PASSWORD',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Get user with current password hash
        const users = await executeQuery(
            'SELECT id, email, password_hash FROM users_tbl WHERE id = ? LIMIT 1',
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                code: 'USER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const user = users[0];

        // Verify current password
        const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);

        if (!passwordMatch) {
            logger.warn(`Password change failed - incorrect current password for user ${userId}`);
            return res.status(401).json({
                success: false,
                error: "Current password is incorrect",
                code: 'INCORRECT_PASSWORD',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Hash new password
        const saltRounds = 12;
        const hashedNewPassword = await bcrypt.hash(filteredNewPassword, saltRounds);

        // Update password
        await executeQuery(
            'UPDATE users_tbl SET password_hash = ?, updated_at = NOW() WHERE id = ?',
            [hashedNewPassword, userId]
        );

        const processingTime = Date.now() - startTime;
        res.json({
            success: true,
            message: "Password updated successfully",
            meta: {
                processingTime: `${processingTime}ms`,
                updatedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error("Password update error:", error);

        res.status(500).json({
            success: false,
            error: "Failed to update password. Please try again.",
            code: 'PASSWORD_UPDATE_ERROR',
            processingTime: `${processingTime}ms`
        });
    }
});

// Update Mobile Number Endpoint
router.put("/update-mobile/:userId", profileUpdateLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { userId } = req.params;
        const { mobile } = req.body;

        // Validation
        if (!mobile) {
            return res.status(400).json({
                success: false,
                error: "Mobile number is required",
                code: 'MISSING_MOBILE',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const normalizedMobile = mobile.trim();
        const mobileRegex = /^[0-9+\-\s()]{10,15}$/;

        if (!mobileRegex.test(normalizedMobile)) {
            return res.status(400).json({
                success: false,
                error: "Please enter a valid mobile number (10-15 digits)",
                code: 'INVALID_MOBILE',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Check if user exists
        const userCheck = await executeQuery(
            'SELECT id FROM users_tbl WHERE id = ? LIMIT 1',
            [userId]
        );

        if (userCheck.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                code: 'USER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Get pensioner data including source_table to know which table to update
        const pensionerData = await executeQuery(`
            SELECT p.hero_ndx, p.id as pensioner_id, p.source_table, p.type
            FROM pensioners_tbl p
            JOIN users_tbl u ON u.pensioner_ndx = p.id
            WHERE u.id = ?
            LIMIT 1`,
            [userId]
        );

        if (pensionerData.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Pensioner record not found",
                code: 'PENSIONER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const { hero_ndx, source_table, type } = pensionerData[0];

        // Validate source_table
        if (!source_table || (source_table !== 'test_table' && source_table !== 'test_res_table')) {
            logger.error(`Invalid source_table: ${source_table} for hero_ndx ${hero_ndx}`);
            return res.status(500).json({
                success: false,
                error: "Invalid source table configuration",
                code: 'INVALID_SOURCE_TABLE',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Dynamically update the correct table based on source_table
        const updateQuery = `UPDATE ${source_table} SET MOBILENR = ? WHERE NDX = ?`;
        const updateResult = await executeQuery(updateQuery, [normalizedMobile, hero_ndx]);

        // Check if the update actually affected any rows
        if (updateResult.affectedRows === 0) {
            logger.error(`Mobile update failed - no rows affected for hero_ndx ${hero_ndx} in ${source_table}`);
            return res.status(500).json({
                success: false,
                error: `Failed to update mobile number - record not found in ${source_table}`,
                code: 'UPDATE_FAILED',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Verify the update worked
        const verifyQuery = `SELECT MOBILENR FROM ${source_table} WHERE NDX = ? LIMIT 1`;
        const verifyData = await executeQuery(verifyQuery, [hero_ndx]);

        if (verifyData.length === 0 || verifyData[0]?.MOBILENR !== normalizedMobile) {
            logger.error(`Mobile update verification failed for hero_ndx ${hero_ndx} in ${source_table}`);
            return res.status(500).json({
                success: false,
                error: "Failed to verify mobile number update",
                code: 'VERIFICATION_FAILED',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const processingTime = Date.now() - startTime;

        res.json({
            success: true,
            message: "Mobile number updated successfully",
            data: {
                mobile: normalizedMobile,
                heroNdx: hero_ndx,
                sourceTable: source_table,
                userType: type
            },
            meta: {
                processingTime: `${processingTime}ms`,
                updatedAt: new Date().toISOString(),
                affectedRows: updateResult.affectedRows
            }
        });

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error("Mobile update error:", error);

        res.status(500).json({
            success: false,
            error: "Failed to update mobile number. Please try again.",
            code: 'MOBILE_UPDATE_ERROR',
            details: error.message,
            processingTime: `${processingTime}ms`
        });
    }
});

// ==================== RESET PASSWORD ROUTES ====================
router.post("/forgot-password", sanitizeInput, validateDatabaseConnection, async (req, res) => {
  const startTime = Date.now();
  let connection = null;

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
        code: 'EMAIL_REQUIRED'
      });
    }

    if (!validator.isEmail(email)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email format",
        code: 'INVALID_EMAIL_FORMAT'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const users = await executeQuery(
      'SELECT id, email FROM users_tbl WHERE email = ? AND deleted_at IS NULL',
      [normalizedEmail]
    );

    if (users.length === 0) {
      return res.status(200).json({
        success: true,
        message: "If an account exists with this email, a reset code has been sent.",
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const user = users[0];
    connection = await getConnection();

    try {
      await connection.beginTransaction();

      const [recentCodes] = await connection.execute(
        `SELECT created_at FROM password_resets 
         WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE)
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );

      if (recentCodes.length > 0) {
        await connection.rollback();
        return res.status(429).json({
          success: false,
          error: "Please wait 1 minute before requesting another code",
          code: 'RATE_LIMITED'
        });
      }

      await connection.execute(
        'UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0',
        [user.id]
      );

      const resetCode = crypto.randomInt(10000, 99999).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await connection.execute(
        `INSERT INTO password_resets (user_id, code, expires_at) 
         VALUES (?, ?, ?)`,
        [user.id, resetCode, expiresAt]
      );

      await connection.commit();

      // Send email with reset code
      const mailOptions = {
        from: process.env.SMTP_FROM, 
        to: user.email,
        subject: 'Password Reset Code',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
            <meta charset="UTF-8">
            <style>
                body {
                font-family: 'Segoe UI', Arial, sans-serif;
                line-height: 1.6;
                color: #222;
                background-color: #e5e7eb;
                margin: 0;
                padding: 0;
                }

                .container {
                max-width: 600px;
                margin: 40px auto;
                background: #ffffff;
                border-radius: 10px;
                overflow: hidden;
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                }

                .header {
                background: linear-gradient(135deg, #1e3a2a 0%, #2f5233 100%);
                color: white;
                padding: 25px 20px;
                text-align: center;
                border-bottom: 5px solid #c9b458;
                }

                .header img {
                width: 90px;
                height: auto;
                margin-bottom: 10px;
                }

                .header h1 {
                margin: 0;
                font-size: 22px;
                text-transform: uppercase;
                letter-spacing: 1px;
                }

                .content {
                padding: 30px;
                background-color: #f9fafb;
                }

                .code-box {
                background: white;
                border: 2px dashed #2f5233;
                padding: 20px;
                text-align: center;
                margin: 20px 0;
                border-radius: 8px;
                }

                .code {
                font-size: 36px;
                font-weight: bold;
                color: #1e3a2a;
                letter-spacing: 8px;
                font-family: 'Courier New', monospace;
                }

                .warning {
                background: #fff3cd;
                border-left: 5px solid #b38f00;
                padding: 12px 16px;
                margin: 25px 0;
                border-radius: 6px;
                font-size: 14px;
                }

                .footer {
                text-align: center;
                color: #6b7280;
                font-size: 12px;
                padding: 15px;
                background: #f3f4f6;
                border-top: 1px solid #e5e7eb;
                }

                strong {
                color: #111827;
                }
            </style>
            </head>
            <body>
            <div class="container">
                <div class="header">
                <img src="https://psahelpline.ph/img/ecert/afp/PGMC.png" alt="AFP Logo" />
                <h1>Password Change Request</h1>
                </div>

                <div class="content">
                <p>Dear Pensioner,</p>
                <p>You have submitted a password change request.</p>
                <p>Use the verification code below to reset your password:</p>

                <div class="code-box">
                    <div class="code">${resetCode}</div>
                    <p style="margin: 10px 0 0; color: #666; font-size: 14px;">
                    This code will expire in <strong>10 minutes</strong>.
                    </p>
                </div>

                <p>If you did not request this code, you can safely ignore this email — your password will remain unchanged. <strong>Do not give this code to anyone</strong></p>

                <p>Respectfully,<br><strong>AFP Pension and Gratuity Management Center Team</strong></p>
                </div>

                <div class="footer">
                <p>This is an automated message. Please do not reply to this email.</p>
                <p>&copy; ${new Date().getFullYear()} AFP Pension and Gratuity Management Center. All rights reserved.</p>
                </div>
            </div>
            </body>
            </html>
        `
      };

<<<<<<< Updated upstream
      try {
        logger.info('Attempting to send reset code email...', {
          to: user.email,
          from: process.env.SMTP_FROM
        });

        const info = await transporter.sendMail(mailOptions);
        
        logger.info('✅ Reset code email sent successfully:', {
          messageId: info.messageId,
          to: user.email,
          response: info.response
        });

      } catch (emailError) {
        logger.error('❌ Email sending failed:', {
          error: emailError.message,
          code: emailError.code,
          command: emailError.command,
          response: emailError.response,
          to: user.email
        });

        // In development, show actual error
        if (process.env.NODE_ENV === 'development') {
          return res.status(500).json({
            success: false,
            error: 'Email sending failed: ' + emailError.message,
            code: 'EMAIL_FAILED'
          });
=======
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          logger.error('Email sending failed:', error);
        } else {
          logger.info('Reset code email sent:', info.messageId);
>>>>>>> Stashed changes
        }
        
        logger.warn('Email failed but continuing for security reasons');
      }

      res.status(200).json({
        success: true,
        message: "If an account exists with this email, a reset code has been sent.",
        processingTime: `${Date.now() - startTime}ms`
      });

    } catch (error) {
      if (connection) await connection.rollback();
      throw error;
    }

  } catch (error) {
    logger.error("Forgot password error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to process password reset request",
      code: 'PASSWORD_RESET_FAILED',
      processingTime: `${Date.now() - startTime}ms`
    });

  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (e) {
        logger.error('Connection release failed:', e);
      }
    }
  }
});
router.post("/verify-reset-code", sanitizeInput, validateDatabaseConnection, async (req, res) => {
  const startTime = Date.now();

  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        error: "Email and code are required",
        code: 'MISSING_FIELDS'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find valid reset code
    const resets = await executeQuery(
      `SELECT pr.id, pr.user_id, pr.expires_at 
       FROM password_resets pr
       JOIN users_tbl u ON pr.user_id = u.id
       WHERE u.email = ? AND pr.code = ? AND pr.used = 0
       ORDER BY pr.created_at DESC LIMIT 1`,
      [normalizedEmail, code]
    );

    if (resets.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired reset code",
        code: 'INVALID_CODE'
      });
    }

    const reset = resets[0];
    const now = new Date();
    const expiresAt = new Date(reset.expires_at);

    if (now > expiresAt) {
      return res.status(400).json({
        success: false,
        error: "Reset code has expired",
        code: 'CODE_EXPIRED'
      });
    }

    // Code is valid
    res.status(200).json({
      success: true,
      message: "Code verified successfully",
      data: {
        resetId: reset.id,
        userId: reset.user_id
      },
      processingTime: `${Date.now() - startTime}ms`
    });

  } catch (error) {
    logger.error("Verify code error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to verify reset code",
      code: 'VERIFICATION_FAILED',
      processingTime: `${Date.now() - startTime}ms`
    });
  }
});

router.post("/reset-password", sanitizeInput, validateDatabaseConnection, async (req, res) => {
  const startTime = Date.now();
  let connection = null;

  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        error: "Email, code, and new password are required",
        code: 'MISSING_FIELDS'
      });
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: "Weak password",
        details: passwordValidation.errors,
        code: 'PASSWORD_TOO_WEAK'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    connection = await getConnection();

    try {
      await connection.beginTransaction();

      // Find and validate reset code
      const [resets] = await connection.execute(
        `SELECT pr.id, pr.user_id, pr.expires_at, u.password_hash
         FROM password_resets pr
         JOIN users_tbl u ON pr.user_id = u.id
         WHERE u.email = ? AND pr.code = ? AND pr.used = 0
         FOR UPDATE`,
        [normalizedEmail, code]
      );

      if (resets.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "Invalid or expired reset code",
          code: 'INVALID_CODE'
        });
      }

      const reset = resets[0];
      const now = new Date();
      const expiresAt = new Date(reset.expires_at);

      if (now > expiresAt) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "Reset code has expired",
          code: 'CODE_EXPIRED'
        });
      }

      // Check if new password is same as old password
      const isSamePassword = await bcrypt.compare(newPassword, reset.password_hash);
      if (isSamePassword) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "New password must be different from your current password",
          code: 'SAME_PASSWORD'
        });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Update password
      await connection.execute(
        'UPDATE users_tbl SET password_hash = ?, updated_at = NOW() WHERE id = ?',
        [hashedPassword, reset.user_id]
      );

      // Mark reset code as used
      await connection.execute(
        'UPDATE password_resets SET used = 1 WHERE id = ?',
        [reset.id]
      );

      await connection.commit();

      // Send confirmation email
      const [users] = await connection.execute(
        'SELECT email FROM users_tbl WHERE id = ?',
        [reset.user_id]
      );

      if (users.length > 0) {
        const confirmationEmail = {
          from: `"AFP Pension and Gratuity Management Center" <${process.env.SMTP_USER}>`,
          to: users[0].email,
          subject: 'Password Successfully Changed',
          html: `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                          color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
                .success-icon { font-size: 48px; text-align: center; margin: 20px 0; }
                .warning { background: #fff3cd; border-left: 4px solid #ffc107; 
                           padding: 12px; margin: 20px 0; }
                .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>Password Changed Successfully</h1>
                </div>
                <div class="content">
                  <div class="success-icon">✅</div>
                  <p>Hello,</p>
                  <p>Your password has been successfully changed.</p>
                  <p>You can now log in to your AFP Pension and Gratuity Management Center account using your new password.</p>

                  <div class="warning">
                    <strong>⚠️ Security Notice:</strong><br>
                    If you did not make this change, please contact support immediately 
                    as your account may be compromised.
                  </div>

                  <p style="margin-top: 30px;">
                    <strong>Time:</strong> ${new Date().toLocaleString('en-US', { 
                      timeZone: 'Asia/Manila',
                      dateStyle: 'full',
                      timeStyle: 'long'
                    })}
                  </p>

                  <p>Best regards,<br>AFP Pension and Gratuity Management Center Team</p>
                </div>
                <div class="footer">
                  <p>&copy; ${new Date().getFullYear()} AFP Pension and Gratuity Management Center. All rights reserved.</p>
                </div>
              </div>
            </body>
            </html>
          `
        };

        transporter.sendMail(confirmationEmail, (error, info) => {
          if (error) {
            logger.error('Confirmation email failed:', error);
          } else {
            logger.info('Password change confirmation sent:', info.messageId);
          }
        });
      }

      res.status(200).json({
        success: true,
        message: "Password reset successfully",
        processingTime: `${Date.now() - startTime}ms`
      });

    } catch (error) {
      if (connection) await connection.rollback();
      throw error;
    }

  } catch (error) {
    logger.error("Reset password error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to reset password",
      code: 'PASSWORD_RESET_FAILED',
      processingTime: `${Date.now() - startTime}ms`
    });

  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (e) {
        logger.error('Connection release failed:', e);
      }
    }
  }
});

const cleanupExpiredCodes = async () => {
  try {
    await executeQuery(
      'DELETE FROM password_resets WHERE expires_at < NOW() OR (used = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR))'
    );
    logger.info('Expired reset codes cleaned up');
  } catch (error) {
    logger.error('Cleanup failed:', error);
  }
};

setInterval(cleanupExpiredCodes, 60 * 60 * 1000);

router.get("/profile/:userId", validateDatabaseConnection, async (req, res) => {
  const startTime = Date.now();

  try {
    const { userId } = req.params;

    // First, get pensioner info to know which table to use
    const pensionerInfo = await executeQuery(
      `
        SELECT 
            p.id,
            p.hero_ndx,
            p.source_table,
            p.type,
            p.bos,
            p.b_type,
            p.principal_firstname,
            p.principal_lastname
        FROM users_tbl u
        JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
        WHERE u.id = ?
        LIMIT 1
      `,
      [userId]
    );

    if (pensionerInfo.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Pensioner record not found",
        code: "PENSIONER_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const pensioner = pensionerInfo[0];
    const sourceTable = pensioner.source_table || "test_table"; // default

    // ✅ Allow beneficiaries_table
    const validTables = ["test_table", "test_res_table", "beneficiaries_table"];
    if (!validTables.includes(sourceTable)) {
      logger.error(`Invalid source_table: ${sourceTable} for user ${userId}`);
      return res.status(500).json({
        success: false,
        error: "Invalid source table configuration",
        code: "INVALID_SOURCE_TABLE",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    // ✅ Now query using the correct table
    const userProfile = await executeQuery(
      `
        SELECT 
            u.id as user_id,
            u.email,
            u.status,
            u.home_address,
            u.created_at,
            u.last_login,
            u.updated_at,
            u.profile_picture,
            u.pensioner_ndx as pensioner_id,
            p.type,
            p.bos,
            p.b_type,
            p.source_table,
            p.principal_firstname,
            p.principal_lastname,
            h.FIRSTNAME,
            h.LASTNAME,
            h.AFPSN,
            h.DOB,
            h.MOBILENR,
            h.CTRLNR,
            h.PENRANK,
            h.ACRANK
        FROM users_tbl u
        JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
        JOIN ${sourceTable} h ON p.hero_ndx = h.NDX
        WHERE u.id = ?
        LIMIT 1
      `,
      [userId]
    );

    if (userProfile.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User profile not found",
        code: "PROFILE_NOT_FOUND",
        processingTime: `${Date.now() - startTime}ms`,
      });
    }

    const profile = userProfile[0];

    // ✅ Handle AFPSN formatting based on PENRANK
    const formattedAFPSN =
      profile.PENRANK &&
      [
        "2LT",
        "1LT",
        "CPT",
        "MAJ",
        "LTC",
        "COMMO",
        "LTCOL",
        "COL",
        "BGEN",
        "MGEN",
        "LGEN",
        "CDR",
      ].includes(profile.PENRANK)
        ? profile.AFPSN?.startsWith("O-")
          ? profile.AFPSN
          : `O-${profile.AFPSN}`
        : profile.AFPSN;

    const processingTime = Date.now() - startTime;

    // ✅ Unified response
    res.json({
      success: true,
      user_id: profile.user_id,
      EMAIL: profile.email,
      home_address: profile.home_address,
      profile_picture: profile.profile_picture,
      pensioner_id: profile.pensioner_id,
      status: profile.status,
      FIRSTNAME: profile.FIRSTNAME,
      LASTNAME: profile.LASTNAME,
      AFPSN: formattedAFPSN,
      DOB: profile.DOB,
      MOBILENR: profile.MOBILENR,
      BOS: profile.bos,
      TYPE: profile.type,
      SOURCE_TABLE: profile.source_table,
      CTRLNR: profile.CTRLNR,
      ACRANK: profile.ACRANK,
      PENRANK: profile.PENRANK,
      ...(profile.type === "B" && {
        B_TYPE: profile.b_type,
        PRINCIPAL_FIRSTNAME: profile.principal_firstname,
        PRINCIPAL_LASTNAME: profile.principal_lastname,
      }),
      created_at: profile.created_at,
      last_login: profile.last_login,
      updated_at: profile.updated_at,
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
        sourceTable: sourceTable,
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error("Profile fetch error:", error);

    res.status(500).json({
      success: false,
      error: "Failed to fetch profile",
      code: "PROFILE_FETCH_ERROR",
      details: error.message,
      processingTime: `${processingTime}ms`,
    });
  }
});

// ==================== PUSH NOTIFICATION ROUTES ====================

// Register/Update push token
router.post("/:userId/push-token", 
    pushTokenLimiter, 
    sanitizeInput, 
    validateDatabaseConnection, 
    async (req, res) => {
        const startTime = Date.now();
        
        try {
            const { userId } = req.params;
                    
            const { push_token, fcm_token, platform, device_token, device_token_type } = req.body;

            // Validate that at least one token is provided
            if (!push_token && !fcm_token) {
                return res.status(400).json({
                    success: false,
                    error: "At least one push token (push_token or fcm_token) is required",
                    code: 'MISSING_PUSH_TOKEN',
                    processingTime: `${Date.now() - startTime}ms`
                });
            }

            // Validate Expo token format if provided
            if (push_token) {
                const tokenPattern = /^ExponentPushToken\[[a-zA-Z0-9_-]+\]$/;
                if (!tokenPattern.test(push_token)) {
                    return res.status(400).json({
                        success: false,
                        error: "Invalid Expo push token format",
                        code: 'INVALID_TOKEN_FORMAT',
                        processingTime: `${Date.now() - startTime}ms`
                    });
                }
            }

            // Check if user exists
            const userCheck = await executeQuery(
                'SELECT id FROM users_tbl WHERE id = ? LIMIT 1',
                [userId]
            );

            if (userCheck.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "User not found",
                    code: 'USER_NOT_FOUND',
                    processingTime: `${Date.now() - startTime}ms`
                });
            }

            // Update push tokens (store both)
            const result = await executeQuery(
                `UPDATE users_tbl 
                 SET push_token = ?, 
                     fcm_token = ?, 
                     platform = ?,
                     device_token = ?,
                     device_token_type = ?,
                     updated_at = NOW() 
                 WHERE id = ?`,
                [push_token || null, fcm_token || null, platform || null, device_token || null, device_token_type || null, userId]
            );

            if (result.affectedRows === 0) {
                return res.status(500).json({
                    success: false,
                    error: "Failed to update push token",
                    code: 'UPDATE_FAILED',
                    processingTime: `${Date.now() - startTime}ms`
                });
            }

            const processingTime = Date.now() - startTime;
            res.json({
                success: true,
                message: "Push tokens saved successfully",
                tokens: {
                    expo: !!push_token,
                    fcm: !!fcm_token,
                    platform: platform
                },
                meta: {
                    processingTime: `${processingTime}ms`,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (error) {
            const processingTime = Date.now() - startTime;
            logger.error("Push token update error:", error);

            res.status(500).json({
                success: false,
                error: "Failed to save push token",
                code: 'PUSH_TOKEN_ERROR',
                details: error.message,
                processingTime: `${processingTime}ms`
            });
        }
    }
);

// Delete push token
router.delete("/:userId/push-token", 
    pushTokenLimiter, 
    sanitizeInput, 
    validateDatabaseConnection, 
    async (req, res) => {
        const startTime = Date.now();
        
        try {
            const { userId } = req.params;

            // Check if user exists
            const userCheck = await executeQuery(
                'SELECT id FROM users_tbl WHERE id = ? LIMIT 1',
                [userId]
            );

            if (userCheck.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "User not found",
                    code: 'USER_NOT_FOUND',
                    processingTime: `${Date.now() - startTime}ms`
                });
            }

            // Remove both push tokens
            const result = await executeQuery(
                `UPDATE users_tbl 
                 SET push_token = NULL, 
                     fcm_token = NULL, 
                     updated_at = NOW() 
                 WHERE id = ?`,
                [userId]
            );

            const processingTime = Date.now() - startTime;
            res.json({
                success: true,
                message: "Push tokens removed successfully",
                meta: {
                    processingTime: `${processingTime}ms`,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (error) {
            const processingTime = Date.now() - startTime;
            logger.error("Push token removal error:", error);

            res.status(500).json({
                success: false,
                error: "Failed to remove push tokens",
                code: 'PUSH_TOKEN_DELETE_ERROR',
                details: error.message,
                processingTime: `${processingTime}ms`
            });
        }
    }
);

router.get("/all", validateDatabaseConnection, async (req, res) => {
  const startTime = Date.now();

  try {
    const users = await executeQuery(`
      SELECT 
          u.id AS user_id,
          u.email,
          u.status,
          u.created_at,
          u.last_login,
          u.status_updated_at,
          u.home_address,
          p.type,
          p.bos,
          p.b_type,
          p.source_table,

          CASE 
              WHEN p.source_table = 'test_res_table' THEN h2.FIRSTNAME
              WHEN p.source_table = 'beneficiaries_table' THEN h3.FIRSTNAME
              ELSE h1.FIRSTNAME
          END AS firstname,

          CASE 
              WHEN p.source_table = 'test_res_table' THEN h2.LASTNAME
              WHEN p.source_table = 'beneficiaries_table' THEN h3.LASTNAME
              ELSE h1.LASTNAME
          END AS lastname,

          CASE 
              WHEN p.source_table = 'test_res_table' THEN h2.DOB
              WHEN p.source_table = 'beneficiaries_table' THEN h3.DOB
              ELSE h1.DOB
          END AS dob,

          CASE 
              WHEN p.source_table = 'test_res_table' THEN 
                  CASE 
                      WHEN h2.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'COMMO', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR') 
                      THEN CONCAT('O-', REPLACE(h2.AFPSN, 'O-', ''))
                      ELSE h2.AFPSN
                  END
              WHEN p.source_table = 'beneficiaries_table' THEN 
                  CASE 
                      WHEN h3.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'COMMO', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR') 
                      THEN CONCAT('O-', REPLACE(h3.AFPSN, 'O-', ''))
                      ELSE h3.AFPSN
                  END
              ELSE 
                  CASE 
                      WHEN h1.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'COMMO', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR') 
                      THEN CONCAT('O-', REPLACE(h1.AFPSN, 'O-', ''))
                      ELSE h1.AFPSN
                  END
          END AS afpsn,

          CASE 
              WHEN p.source_table = 'test_res_table' THEN h2.PENRANK
              WHEN p.source_table = 'beneficiaries_table' THEN h3.PENRANK
              ELSE h1.PENRANK
          END AS penrank,

          CASE 
              WHEN p.source_table = 'test_res_table' THEN h2.MOBILENR
              WHEN p.source_table = 'beneficiaries_table' THEN h3.MOBILENR
              ELSE h1.MOBILENR
          END AS mobile

      FROM users_tbl u
      JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
      LEFT JOIN test_table h1 ON p.hero_ndx = h1.NDX AND p.source_table = 'test_table'
      LEFT JOIN test_res_table h2 ON p.hero_ndx = h2.NDX AND p.source_table = 'test_res_table'
      LEFT JOIN beneficiaries_table h3 ON p.hero_ndx = h3.NDX AND p.source_table = 'beneficiaries_table'
      ORDER BY u.created_at DESC
    `);

    const stats = {
      totalUsers: users.length,
      principalUsers: users.filter((u) => u.type === 'P').length,
      beneficiaryUsers: users.filter((u) => u.type === 'B').length,
      activeUsers: users.filter((u) => u.status === 'ACT' || u.status === 'TAG').length,
      testTableUsers: users.filter((u) => u.source_table === 'test_table').length,
      testResTableUsers: users.filter((u) => u.source_table === 'test_res_table').length,
      beneficiariesTableUsers: users.filter((u) => u.source_table === 'beneficiaries_table').length,
    };

    const processingTime = Date.now() - startTime;
    res.json({
      success: true,
      users,
      data: users,
      stats,
      count: users.length,
      meta: {
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error("Fetch all users error:", {
      message: error.message,
      code: error.code,
      errno: error.errno,
    });

    res.status(500).json({
      success: false,
      error: "Failed to fetch users",
      code: "USERS_FETCH_ERROR",
      processingTime: `${processingTime}ms`,
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
