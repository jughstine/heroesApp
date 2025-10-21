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
            "POST /api/users/validate-identity",
            "POST /api/users/create-account",
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
                    { method: "POST", path: "/api/users/validate-step1", description: "Step 1: Validate pensioner type & AFPSN" },
                    { method: "POST", path: "/api/users/validate-step2", description: "Step 2: Validate personal information" },
                    { method: "POST", path: "/api/users/create-account", description: "Step 3: Create user account" },
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

// ===== RATE LIMITERS =====
const identityLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: 'Too many identity validation attempts. Please try again later.',
        code: 'RATE_LIMITED'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const createAccountLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: 'Too many account creation attempts. Please try again later.',
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
            throw error;
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

setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

// SIGNUP 

// OPTIMIZED 2-STEP SIGNUP BACKEND

const OFFICER_RANKS = ['2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN'];

//  Identity Verification (AFP Details + Personal Info)
router.post("/validate-identity", identityLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { 
            type, 
            afpsn, 
            bos, 
            b_type, 
            principal_first_name, 
            principal_last_name,
            firstname,
            lastname,
            dob,
            claims_officer
        } = req.body;

        // ===== VALIDATION: Required Fields =====
        if (!type || !afpsn || !firstname || !lastname || !dob) {
            return res.status(400).json({
                success: false,
                error: "Type, AFP Serial Number, name, and date of birth are required",
                code: 'MISSING_REQUIRED_FIELDS',
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

        if (type === 'P' && !bos) {
            return res.status(400).json({
                success: false,
                error: "Branch of service is required for principal pensioners",
                code: 'MISSING_BOS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        if (type === 'B') {
            if (!b_type || !principal_first_name || !principal_last_name) {
                return res.status(400).json({
                    success: false,
                    error: "Beneficiary type and principal information are required",
                    code: 'MISSING_BENEFICIARY_INFO',
                    processingTime: `${Date.now() - startTime}ms`
                });
            }
        }

        // ===== NORMALIZE DATA =====
        const normalizedAfpsn = afpsn.trim().toUpperCase();
        const normalizedFirstname = firstname.trim().toUpperCase();
        const normalizedLastname = lastname.trim().toUpperCase();

        // ===== STEP 1A: Auto-detect which table the user is in =====
        let detectedTable = null;
        let afpsnRecords = null;
        let penRank = null;

        // Try active payroll first
        afpsnRecords = await executeQuery(`
            SELECT COUNT(*) as count, PENRANK 
            FROM test_table
            WHERE UPPER(TRIM(AFPSN)) = ? AND TYPE = ?
            GROUP BY PENRANK`,
            [normalizedAfpsn, type]
        );

        if (afpsnRecords.length > 0) {
            detectedTable = 'test_table';
            penRank = afpsnRecords[0].PENRANK ? afpsnRecords[0].PENRANK.trim().toUpperCase() : null;
        } else {
            // Fall back to resumption table
            afpsnRecords = await executeQuery(`
                SELECT COUNT(*) as count, PENRANK 
                FROM test_res_table
                WHERE UPPER(TRIM(AFPSN)) = ? AND TYPE = ?
                GROUP BY PENRANK`,
                [normalizedAfpsn, type]
            );

            if (afpsnRecords.length > 0) {
                detectedTable = 'test_res_table';
                penRank = afpsnRecords[0].PENRANK ? afpsnRecords[0].PENRANK.trim().toUpperCase() : null;
            }
        }

        // Record not found in either table
        if (!detectedTable) {
            return res.status(401).json({
                success: false,
                error: "AFP Serial Number not found in our records",
                code: 'AFPSN_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== DETERMINE ACCOUNT STATUS =====
        const account_status = detectedTable === 'test_table' ? 'active' : 'resumption';

        // ===== CHECK OFFICER STATUS (Define BEFORE using) =====
        const isOfficer = penRank ? OFFICER_RANKS.includes(penRank) : false;

        if (claims_officer && !isOfficer) {
            return res.status(400).json({
                success: false,
                error: `You claimed to be an officer, but our records show rank: ${penRank}`,
                code: 'INVALID_OFFICER_CLAIM',
                rank: penRank,
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        if (!claims_officer && isOfficer) {
            return res.status(400).json({
                success: false,
                error: `Our records show you are an officer (${penRank}). Please check the officer box.`,
                code: 'MISSING_OFFICER_CLAIM',
                rank: penRank,
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== STEP 1B: Verify Personal Information MATCHES =====
        const heroes = await executeQuery(`
            SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, CTRLNR, PENRANK, ACRANK
            FROM ${detectedTable}
            WHERE UPPER(TRIM(FIRSTNAME)) = ? 
              AND UPPER(TRIM(LASTNAME)) = ? 
              AND DATE(DOB) = DATE(?) 
              AND UPPER(TRIM(AFPSN)) = ? 
              AND TYPE = ?`,
            [normalizedFirstname, normalizedLastname, dob, normalizedAfpsn, type]
        );

        if (heroes.length === 0) {
            logger.warn(`Identity mismatch in ${detectedTable}: ${normalizedFirstname} ${normalizedLastname}, DOB: ${dob}, AFPSN: ${normalizedAfpsn}`);
            return res.status(401).json({
                success: false,
                error: "Personal information does not match our records. Please verify your details.",
                code: 'PERSONAL_INFO_MISMATCH',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        if (heroes.length > 1) {
            logger.warn(`Multiple heroes found in ${detectedTable}: ${normalizedFirstname} ${normalizedLastname}`);
            return res.status(409).json({
                success: false,
                error: "Multiple matching records found. Please contact support.",
                code: 'DUPLICATE_RECORDS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== CHECK IF ACCOUNT ALREADY EXISTS FOR THIS SPECIFIC TABLE =====
        const heroData = heroes[0];
        const existingAccount = await executeQuery(`
            SELECT u.id, u.status
            FROM users_tbl u 
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
            WHERE p.hero_ndx = ? AND p.source_table = ? AND u.status NOT IN ('DEL')`,
            [heroData.NDX, detectedTable]
        );

        if (existingAccount.length > 0) {
            return res.status(409).json({
                success: false,
                error: "An account already exists for this AFP Serial Number in this record",
                code: 'ACCOUNT_EXISTS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== SUCCESS: All Validations Passed =====
        logger.info(`Identity verified in ${detectedTable}: ${heroData.FIRSTNAME} ${heroData.LASTNAME} (${heroData.AFPSN}), Rank: ${penRank}`);

        // Create comprehensive token with all validated data
        const tokenData = {
            type,
            afpsn: normalizedAfpsn,
            bos: type === 'P' ? bos?.trim().toUpperCase() : null,
            b_type: b_type || null,
            principal_first_name: type === 'B' ? principal_first_name?.trim().toUpperCase() : null,
            principal_last_name: type === 'B' ? principal_last_name?.trim().toUpperCase() : null,
            firstname: normalizedFirstname,
            lastname: normalizedLastname,
            dob,
            hero_ndx: heroData.NDX,
            hero_ctrl_nr: heroData.CTRLNR,
            penRank: penRank || null,
            acRank: heroData.ACRANK || null,
            isOfficer: isOfficer,
            account_status: account_status,
            source_table: detectedTable,
            validated_at: new Date().toISOString()
        };

        const { token } = generateValidationToken(tokenData);
        const identityToken = await storeValidationToken(token, tokenData);

        const processingTime = Date.now() - startTime;
        logger.info(`Identity validation successful for ${normalizedAfpsn} (${account_status}) in ${processingTime}ms`);

        res.json({
            success: true,
            message: "Identity verified successfully",
            identityToken,
            heroData: {
                name: `${heroData.FIRSTNAME} ${heroData.LASTNAME}`,
                afpsn: heroData.AFPSN,
                controlNumber: heroData.CTRLNR,
                type: heroData.TYPE,
                dob: heroData.DOB,
                acRank: heroData.ACRANK || null
            },
            data: {
                type,
                afpsn: normalizedAfpsn,
                rank: penRank,
                isOfficer: isOfficer,
                recordsFound: afpsnRecords[0].count,
                account_status: account_status,
                source_table: detectedTable
            },
            meta: {
                processingTime: `${processingTime}ms`,
                validUntil: new Date(Date.now() + 7200000).toISOString() // 2 hours
            }
        });

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error("Identity validation error:", {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage,
            sqlState: error.sqlState,
            errno: error.errno,
            stack: error.stack
        });

        res.status(500).json({
            success: false,
            error: "Identity validation failed. Please try again.",
            code: 'IDENTITY_VALIDATION_ERROR',
            processingTime: `${processingTime}ms`,
            debug: error.message // Remove in production
        });
    }
});
// Create Account (Email + Password)
router.post("/create-account", createAccountLimiter, sanitizeInput, validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();
    let connection = null;

    try {
        const { identityToken, email, password } = req.body;

        if (!identityToken || !email || !password) {
            return res.status(400).json({
                success: false,
                error: "Identity token, email, and password are required",
                code: 'MISSING_REQUIRED_FIELDS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== VERIFY IDENTITY TOKEN =====
        let validationData;
        try {
            validationData = await getValidationToken(identityToken);
            
            if (!validationData || !validationData.hero_ndx) {
                throw new Error('Invalid validation data: missing hero_ndx');
            }

            logger.info(`Identity token validated for: ${validationData.firstname} ${validationData.lastname} (${validationData.account_status})`);

        } catch (error) {
            logger.warn(`Identity token validation failed: ${error.message}`);
            return res.status(400).json({
                success: false,
                error: "Invalid or expired validation. Please restart the signup process.",
                code: 'INVALID_IDENTITY_TOKEN',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== VALIDATE EMAIL =====
        if (!validator.isEmail(email)) {
            return res.status(400).json({
                success: false,
                error: "Please enter a valid email address",
                code: 'INVALID_EMAIL_FORMAT',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // ===== CHECK FOR EXISTING EMAIL =====
        const existingUsers = await executeQuery(
            'SELECT id FROM users_tbl WHERE email = ? LIMIT 1',
            [normalizedEmail]
        );

        if (existingUsers.length > 0) {
            return res.status(409).json({
                success: false,
                error: "An account with this email already exists",
                code: 'EMAIL_ALREADY_EXISTS',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== DOUBLE-CHECK HERO RECORD AVAILABILITY =====
        const existingHeroAccount = await executeQuery(`
            SELECT u.id 
            FROM users_tbl u 
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
            WHERE p.hero_ndx = ? AND p.source_table = ?`,
            [validationData.hero_ndx, validationData.source_table]
        );

        if (existingHeroAccount.length > 0) {
            return res.status(409).json({
                success: false,
                error: "An account already exists for this military record",
                code: 'RECORD_ALREADY_CLAIMED',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== VALIDATE PASSWORD STRENGTH =====
        const passwordValidation = validatePasswordStrength(password);
        if (!passwordValidation.isValid) {
            return res.status(400).json({
                success: false,
                error: "Password does not meet security requirements",
                details: passwordValidation.errors,
                code: 'PASSWORD_TOO_WEAK',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== HASH PASSWORD =====
        logger.info('Hashing password...');
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        logger.info('Password hashed successfully');

        // ===== ACQUIRE CONNECTION FOR TRANSACTION =====
        try {
            connection = await getConnection();

            if (!connection) {
                throw new Error('Database connection returned null');
            }

            logger.info(`DB connection acquired for: ${normalizedEmail}`);

        } catch (connError) {
            logger.error('Failed to get database connection:', {
                error: connError.message,
                code: connError.code,
                email: normalizedEmail
            });

            return res.status(503).json({
                success: false,
                error: "Database connection unavailable. Please try again.",
                code: 'DB_CONNECTION_UNAVAILABLE',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // ===== TRANSACTION: CREATE ACCOUNT =====
        try {
            await connection.beginTransaction();
            logger.info('Transaction started for account creation');

            // Determine initial user status based on account_status
            let initialUserStatus = 'TAG'; // Default for active accounts
            if (validationData.account_status === 'resumption') {
                initialUserStatus = 'AFR'; // Resumption requires approval
            }

            logger.info('Creating pensioner record', {
                hero_ndx: validationData.hero_ndx,
                type: validationData.type,
                source_table: validationData.source_table,
                account_status: validationData.account_status
            });

            // Create pensioner record with additional metadata
            const [pensionerResult] = await connection.execute(
                `INSERT INTO pensioners_tbl (hero_ndx, source_table, type, bos, b_type, principal_firstname, principal_lastname, account_status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    validationData.hero_ndx,
                    validationData.source_table,  // Add this
                    validationData.type,
                    validationData.bos || null,
                    validationData.b_type || null,
                    validationData.principal_first_name || null,
                    validationData.principal_last_name || null,
                    validationData.account_status
                ]
            );


            const pensionerId = pensionerResult.insertId;

            if (!pensionerId) {
                throw new Error('Failed to create pensioner - no insertId');
            }

            logger.info(`Pensioner created: ID ${pensionerId}`);

            // Create user record with status based on account type
            const [userResult] = await connection.execute(
                `INSERT INTO users_tbl (pensioner_ndx, email, password_hash, status, tagged_at) 
                 VALUES (?, ?, ?, ?, NOW())`,
                [pensionerId, normalizedEmail, hashedPassword, initialUserStatus]
            );

            const userId = userResult.insertId;

            if (!userId) {
                throw new Error('Failed to create user - no insertId');
            }

            logger.info(`User created: ID ${userId} with status: ${initialUserStatus}`);

            // Delete used token to prevent reuse
            await connection.execute(
                'DELETE FROM signup_tokens WHERE token = ?',
                [identityToken]
            );

            await connection.commit();
            logger.info('Transaction committed successfully');

            const processingTime = Date.now() - startTime;
            logger.info(`Account created: ${normalizedEmail} (User: ${userId}, Status: ${initialUserStatus}) in ${processingTime}ms`);

            res.status(201).json({
                success: true,
                message: validationData.account_status === 'resumption' 
                    ? "Account created successfully. Your resumption application is pending approval."
                    : "Account created successfully",
                data: {
                    userId,
                    email: normalizedEmail,
                    pensionerId,
                    type: validationData.type,
                    status: initialUserStatus,
                    account_status: validationData.account_status,
                    source_table: validationData.source_table
                },
                meta: {
                    processingTime: `${processingTime}ms`,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (transactionError) {
            logger.error('Transaction error:', {
                message: transactionError.message,
                code: transactionError.code,
                sqlMessage: transactionError.sqlMessage,
                errno: transactionError.errno
            });

            if (connection) {
                try {
                    await connection.rollback();
                    logger.info('Transaction rolled back');
                } catch (rollbackError) {
                    logger.error('Rollback failed (non-fatal):', {
                        message: rollbackError.message,
                        code: rollbackError.code
                    });
                }
            }

            throw transactionError;
        }

    } catch (error) {
        const processingTime = Date.now() - startTime;

        logger.error("Account creation error:", {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage,
            sqlState: error.sqlState,
            errno: error.errno,
            email: req.body?.email
        });

        let statusCode = 500;
        let errorCode = 'ACCOUNT_CREATION_FAILED';
        let errorMessage = "Account creation failed. Please try again.";

        if (error.code === 'ER_DUP_ENTRY') {
            statusCode = 409;
            errorCode = 'DUPLICATE_ENTRY';
            errorMessage = "Account already exists for this record.";
        } else if (error.code === 'ER_NO_REFERENCED_ROW' || error.code === 'ER_NO_REFERENCED_ROW_2') {
            statusCode = 400;
            errorCode = 'INVALID_HERO_RECORD';
            errorMessage = "Invalid military record reference. The hero record does not exist.";
        } else if (error.code === 'ER_DATA_TOO_LONG') {
            statusCode = 400;
            errorCode = 'DATA_TOO_LONG';
            errorMessage = "One of the fields exceeds the maximum allowed length.";
        } else if (error.code === 'ER_BAD_NULL_ERROR') {
            statusCode = 400;
            errorCode = 'NULL_VALUE_ERROR';
            errorMessage = "Required fields cannot be null.";
        } else if (error.code === 'ER_TRUNCATED_WRONG_VALUE') {
            statusCode = 400;
            errorCode = 'INVALID_DATA_FORMAT';
            errorMessage = "Invalid data format for one of the fields.";
        } else if (error.message && error.message.includes('validation data')) {
            statusCode = 400;
            errorCode = 'INVALID_VALIDATION_DATA';
            errorMessage = "Invalid validation data. Please restart signup.";
        } else if (['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
            statusCode = 503;
            errorCode = 'DB_CONNECTION_ERROR';
            errorMessage = "Database connection issue. Please try again.";
        }

        res.status(statusCode).json({
            success: false,
            error: errorMessage,
            code: errorCode,
            processingTime: `${processingTime}ms`,
            timestamp: new Date().toISOString()
        });

    } finally {
        if (connection) {
            try {
                connection.release();
                logger.debug('Database connection released');
            } catch (releaseError) {
                logger.error('Connection release failed (non-fatal):', {
                    message: releaseError.message,
                    code: releaseError.code
                });
            }
        }
    }
});

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
                p.source_table,
                p.account_status,
                COALESCE(h.FIRSTNAME, h2.FIRSTNAME) as FIRSTNAME,
                COALESCE(h.LASTNAME, h2.LASTNAME) as LASTNAME,
                COALESCE(h.AFPSN, h2.AFPSN) as AFPSN,
                COALESCE(h.CTRLNR, h2.CTRLNR) as CTRLNR,
                COALESCE(h.TYPE, h2.TYPE) as hero_type
            FROM users_tbl u
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
            LEFT JOIN test_table h ON p.hero_ndx = h.NDX AND p.source_table = 'test_table'
            LEFT JOIN test_res_table h2 ON p.hero_ndx = h2.NDX AND p.source_table = 'test_res_table'
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
        logger.info(`User found: ${user.email}, Status: ${user.user_status}, Source: ${user.source_table}`);

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
                account_status: user.account_status,
                source_table: user.source_table,
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
        logger.info(`Email updated successfully for user ${userId}: ${normalizedEmail} in ${processingTime}ms`);

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
        logger.info(`Password updated successfully for user ${userId} (${user.email}) in ${processingTime}ms`);

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

        logger.info(`Updating mobile for user ${userId}, type: ${type}, hero_ndx: ${hero_ndx}, source_table: ${source_table}`);

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
        logger.info(`✅ Mobile number updated successfully for user ${userId} (hero_ndx: ${hero_ndx}) in ${source_table} - ${processingTime}ms`);

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

router.get("/profile/:userId", validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        const { userId } = req.params;

        // First, get the pensioner info to determine which table to query
        const pensionerInfo = await executeQuery(`
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
        `, [userId]);

        if (pensionerInfo.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Pensioner record not found",
                code: 'PENSIONER_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const pensioner = pensionerInfo[0];
        const sourceTable = pensioner.source_table || 'test_table'; // Default to test_table if null

        // Validate source table
        if (sourceTable !== 'test_table' && sourceTable !== 'test_res_table') {
            logger.error(`Invalid source_table: ${sourceTable} for user ${userId}`);
            return res.status(500).json({
                success: false,
                error: "Invalid source table configuration",
                code: 'INVALID_SOURCE_TABLE',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        // Now query with the correct source table
        const userProfile = await executeQuery(`
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
        `, [userId]);

        if (userProfile.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User profile not found",
                code: 'PROFILE_NOT_FOUND',
                processingTime: `${Date.now() - startTime}ms`
            });
        }

        const profile = userProfile[0];
        
        // Format AFPSN with O- prefix for officers
        const formattedAFPSN = profile.PENRANK && 
            ['2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN'].includes(profile.PENRANK)
            ? `O-${profile.AFPSN}`
            : profile.AFPSN;

        const processingTime = Date.now() - startTime;

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
            ...(profile.type === 'B' && {
                B_TYPE: profile.b_type,
                PRINCIPAL_FIRSTNAME: profile.principal_firstname,
                PRINCIPAL_LASTNAME: profile.principal_lastname
            }),
            created_at: profile.created_at,
            last_login: profile.last_login,
            updated_at: profile.updated_at,
            meta: {
                processingTime: `${processingTime}ms`,
                timestamp: new Date().toISOString(),
                sourceTable: sourceTable
            }
        });

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error("Profile fetch error:", error);

        res.status(500).json({
            success: false,
            error: "Failed to fetch profile",
            code: 'PROFILE_FETCH_ERROR',
            details: error.message,
            processingTime: `${processingTime}ms`
        });
    }
});

router.get("/all", validateDatabaseConnection, async (req, res) => {
    const startTime = Date.now();

    try {
        logger.info('Fetching all users for admin dashboard');

        const users = await executeQuery(`
            SELECT 
                u.id AS user_id,
                u.email,
                u.status,
                u.created_at,
                u.last_login,
                u.status_updated_at,
                p.type,
                p.bos,
                p.b_type,
                p.source_table,

                CASE 
                    WHEN p.source_table = 'test_res_table' THEN h2.FIRSTNAME 
                    ELSE h1.FIRSTNAME 
                END AS firstname,

                CASE 
                    WHEN p.source_table = 'test_res_table' THEN h2.LASTNAME 
                    ELSE h1.LASTNAME 
                END AS lastname,

                CASE 
                    WHEN p.source_table = 'test_res_table' THEN h2.DOB
                    ELSE h1.DOB
                END AS dob,

                CASE 
                    WHEN p.source_table = 'test_res_table' THEN 
                        CASE 
                            WHEN h2.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN') 
                            THEN CONCAT('O-', REPLACE(h2.AFPSN, 'O-', ''))
                            ELSE h2.AFPSN
                        END
                    ELSE 
                        CASE 
                            WHEN h1.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN') 
                            THEN CONCAT('O-', REPLACE(h1.AFPSN, 'O-', ''))
                            ELSE h1.AFPSN
                        END
                END AS afpsn,

                CASE 
                    WHEN p.source_table = 'test_res_table' THEN h2.PENRANK 
                    ELSE h1.PENRANK 
                END AS penrank,

                CASE 
                    WHEN p.source_table = 'test_res_table' THEN h2.MOBILENR 
                    ELSE h1.MOBILENR 
                END AS mobile

            FROM users_tbl u
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
            LEFT JOIN test_table h1 ON p.hero_ndx = h1.NDX AND p.source_table = 'test_table'
            LEFT JOIN test_res_table h2 ON p.hero_ndx = h2.NDX AND p.source_table = 'test_res_table'
            ORDER BY u.created_at DESC
        `);

        const stats = {
            totalUsers: users.length,
            principalUsers: users.filter((u) => u.type === 'P').length,
            beneficiaryUsers: users.filter((u) => u.type === 'B').length,
            activeUsers: users.filter((u) => u.status === 'ACT' || u.status === 'TAG').length,
            testTableUsers: users.filter((u) => u.source_table === 'test_table').length,
            testResTableUsers: users.filter((u) => u.source_table === 'test_res_table').length,
        };

        const processingTime = Date.now() - startTime;
        logger.info(`Retrieved ${users.length} users in ${processingTime}ms`);

        res.json({
            success: true,
            users,
            data: users,
            stats,
            count: users.length,
            meta: {
                processingTime: `${processingTime}ms`,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error("Fetch all users error:", {
            message: error.message,
            code: error.code,
            errno: error.errno
        });

        res.status(500).json({
            success: false,
            error: "Failed to fetch users",
            code: 'USERS_FETCH_ERROR',
            processingTime: `${processingTime}ms`,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;