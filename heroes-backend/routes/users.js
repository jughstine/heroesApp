const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const router = express.Router();
const { getConnection, executeQuery, healthCheck, testConnection, logger } = require('../config/database');

const TOKEN_EXPIRY_HOURS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

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
    message: { success: false, error: 'Too many identity validation attempts. Please try again later.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const createAccountLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 10,
    message: { success: false, error: 'Too many account creation attempts. Please try again later.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { success: false, error: 'Too many login attempts. Please try again after 15 minutes.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
});

const pushTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
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

// OPTIMIZED 2-STEP SIGNUP BACKEND

const OFFICER_RANKS = ['2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'LTCOL','COMMO', 'COL', 'CDR', 'BGEN', 'MGEN', 'LGEN'];
function normalizeAfpsnForMatching(afpsn) {
    if (!afpsn) return '';
    
    const cleaned = afpsn.trim().toUpperCase();
    const numericOnly = cleaned.replace(/^[A-Z]-?/, '').replace(/[A-Z]+$/, '');
    
    return numericOnly;
}

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

        const normalizedAfpsn = afpsn.trim().toUpperCase();
        const normalizedAfpsnNumeric = normalizeAfpsnForMatching(normalizedAfpsn);
        const normalizedFirstname = firstname.trim().toUpperCase();
        const normalizedLastname = lastname.trim().toUpperCase();

        // Auto-detect table (active vs resumption)
        let detectedTable = null;
        let afpsnRecords = null;
        let penRank = null;

        afpsnRecords = await executeQuery(
            `SELECT COUNT(*) as count, PENRANK, AFPSN FROM test_table
            WHERE REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X', '') LIKE ? AND TYPE = ? 
            GROUP BY PENRANK, AFPSN`,
            [`%${normalizedAfpsnNumeric}%`, type]
        );

        if (afpsnRecords.length > 0) {
            detectedTable = 'test_table';
            penRank = afpsnRecords[0].PENRANK?.trim().toUpperCase();
        } else {
            afpsnRecords = await executeQuery(
                `SELECT COUNT(*) as count, PENRANK, AFPSN FROM test_res_table
                WHERE REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X', '') LIKE ? AND TYPE = ? 
                GROUP BY PENRANK, AFPSN`,
                [`%${normalizedAfpsnNumeric}%`, type]
            );

            if (afpsnRecords.length > 0) {
                detectedTable = 'test_res_table';
                penRank = afpsnRecords[0].PENRANK?.trim().toUpperCase();
            }
        }

        if (!detectedTable) {
            return res.status(401).json({ success: false, error: "AFP Serial Number not found", code: 'AFPSN_NOT_FOUND' });
        }

        const account_status = detectedTable === 'test_table' ? 'active' : 'resumption';
        const isOfficer = penRank ? OFFICER_RANKS.includes(penRank) : false;

        // Officer validation
        if (claims_officer && !isOfficer) {
            return res.status(400).json({ success: false, error: `Rank mismatch: ${penRank}`, code: 'INVALID_OFFICER_CLAIM', rank: penRank });
        }
        if (!claims_officer && isOfficer) {
            return res.status(400).json({ success: false, error: `You are an officer (${penRank})`, code: 'MISSING_OFFICER_CLAIM', rank: penRank });
        }

        // Verify personal information
        const heroes = await executeQuery(
            `SELECT NDX, FIRSTNAME, LASTNAME, AFPSN, DOB, TYPE, CTRLNR, PENRANK, ACRANK
            FROM ${detectedTable}
            WHERE UPPER(TRIM(FIRSTNAME)) = ? 
            AND UPPER(TRIM(LASTNAME)) = ? 
            AND DATE(DOB) = DATE(?) 
            AND REPLACE(REPLACE(UPPER(TRIM(AFPSN)), 'O-', ''), 'X', '') LIKE ?
            AND TYPE = ?`,
            [normalizedFirstname, normalizedLastname, dob, `%${normalizedAfpsnNumeric}%`, type]
        );

        if (heroes.length === 0) {
            return res.status(401).json({ success: false, error: "Personal information mismatch", code: 'PERSONAL_INFO_MISMATCH' });
        }
        if (heroes.length > 1) {
            return res.status(409).json({ success: false, error: "Multiple records found", code: 'DUPLICATE_RECORDS' });
        }

        const heroData = heroes[0];

        const existingAccount = await executeQuery(
            `SELECT u.id, u.status, h.FIRSTNAME, h.LASTNAME, h.AFPSN
            FROM users_tbl u 
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id 
            LEFT JOIN ${detectedTable} h ON p.hero_ndx = h.NDX
            WHERE REPLACE(REPLACE(UPPER(TRIM(h.AFPSN)), 'O-', ''), 'X', '') LIKE ?
            AND UPPER(TRIM(h.FIRSTNAME)) = ?
            AND UPPER(TRIM(h.LASTNAME)) = ?
            AND p.source_table = ?
            AND u.status NOT IN ('DEL')
            FOR UPDATE`,
            [`%${normalizedAfpsnNumeric}%`, normalizedFirstname, normalizedLastname, detectedTable]
        );

        if (existingAccount.length > 0) {
            logger.warn(`Duplicate account attempt: ${normalizedAfpsn} - ${normalizedFirstname} ${normalizedLastname}`);
            return res.status(409).json({ 
                success: false, 
                error: "An account already exists for this person (AFPSN + Name combination)", 
                code: 'ACCOUNT_EXISTS',
                details: {
                    afpsn: normalizedAfpsn,
                    name: `${normalizedFirstname} ${normalizedLastname}`
                }
            });
        }

        // Generate token
        const tokenData = {
            type, afpsn: normalizedAfpsn, bos: type === 'P' ? bos?.trim().toUpperCase() : null,
            b_type: b_type || null,
            principal_first_name: type === 'B' ? principal_first_name?.trim().toUpperCase() : null,
            principal_last_name: type === 'B' ? principal_last_name?.trim().toUpperCase() : null,
            firstname: normalizedFirstname, lastname: normalizedLastname, dob,
            hero_ndx: heroData.NDX, hero_ctrl_nr: heroData.CTRLNR,
            penRank, acRank: heroData.ACRANK, isOfficer, account_status, source_table: detectedTable,
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
                controlNumber: heroData.CTRLNR,
                type: heroData.TYPE,
                dob: heroData.DOB
            },
            data: { type, afpsn: normalizedAfpsn, rank: penRank, isOfficer, account_status, source_table: detectedTable },
            meta: { processingTime: `${Date.now() - startTime}ms`, validUntil: new Date(Date.now() + TOKEN_EXPIRY_HOURS * 3600000).toISOString() }
        });

    } catch (error) {
        logger.error("Identity validation error:", error);
        res.status(500).json({ success: false, error: "Identity validation failed", code: 'IDENTITY_VALIDATION_ERROR' });
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
            if (!validationData?.hero_ndx) throw new Error('Invalid validation data');
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

        // CRITICAL FIX: Set isolation level BEFORE starting transaction
        await retryWithBackoff(async () => {
            try {
                // Set isolation level FIRST (before beginTransaction)
                await connection.execute('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
                
                // NOW start the transaction
                await connection.beginTransaction();

                // **CRITICAL: Lock the hero record to prevent double registration**
                const [heroCheck] = await connection.execute(
                    `SELECT p.id FROM pensioners_tbl p 
                     WHERE p.hero_ndx = ? AND p.source_table = ?
                     FOR UPDATE`,
                    [validationData.hero_ndx, validationData.source_table]
                );

                if (heroCheck.length > 0) {
                    throw { code: 'RECORD_ALREADY_CLAIMED', statusCode: 409, message: 'Account already exists for this record' };
                }

                const initialUserStatus = validationData.account_status === 'resumption' ? 'AFR' : 'TAG';

                // Insert pensioner
                const [pensionerResult] = await connection.execute(
                    `INSERT INTO pensioners_tbl (hero_ndx, source_table, type, bos, b_type, principal_firstname, principal_lastname, account_status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        validationData.hero_ndx, validationData.source_table, validationData.type,
                        validationData.bos || null, validationData.b_type || null,
                        validationData.principal_first_name || null, validationData.principal_last_name || null,
                        validationData.account_status
                    ]
                );

                const pensionerId = pensionerResult.insertId;
                if (!pensionerId) throw new Error('Failed to create pensioner');

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
                    email: normalizedEmail,
                    status: initialUserStatus,
                    account_status: validationData.account_status
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
            res.status(201).json({
                success: true,
                message: validationData.account_status === 'resumption' 
                    ? "Account created. Pending approval."
                    : "Account created successfully",
                data: result,
                meta: { processingTime: `${Date.now() - startTime}ms`, timestamp: new Date().toISOString() }
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

//  login 
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
                u.id as user_id, u.email, u.password_hash, u.status as user_status,
                p.id as pensioner_id, p.type, p.bos, p.source_table, p.account_status,
                COALESCE(h.FIRSTNAME, h2.FIRSTNAME) as FIRSTNAME,
                COALESCE(h.LASTNAME, h2.LASTNAME) as LASTNAME,
                COALESCE(h.AFPSN, h2.AFPSN) as AFPSN,
                COALESCE(h.CTRLNR, h2.CTRLNR) as CTRLNR
            FROM users_tbl u
            JOIN pensioners_tbl p ON u.pensioner_ndx = p.id
            LEFT JOIN test_table h ON p.hero_ndx = h.NDX AND p.source_table = 'test_table'
            LEFT JOIN test_res_table h2 ON p.hero_ndx = h2.NDX AND p.source_table = 'test_res_table'
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
                    control_number: user.CTRLNR
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
        
        const formattedAFPSN =
        profile.PENRANK &&
        ['2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'COMMO', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR'].includes(profile.PENRANK)
            ? (profile.AFPSN.startsWith('O-') ? profile.AFPSN : `O-${profile.AFPSN}`)
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
                            WHEN h2.PENRANK IN ('2LT', '1LT', 'CPT', 'MAJ', 'LTC', 'COMMO', 'LTCOL', 'COL', 'BGEN', 'MGEN', 'LGEN', 'CDR') 
                            THEN CONCAT('O-', REPLACE(h2.AFPSN, 'O-', ''))
                            ELSE h2.AFPSN
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