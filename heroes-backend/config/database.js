const mysql = require('mysql2/promise');
const winston = require('winston');
require('dotenv').config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Validate required environment variables
const validateConfig = () => {
  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate SSL configuration in production (skip for DigitalOcean)
  const isDigitalOcean = process.env.DB_HOST && process.env.DB_HOST.includes('digitalocean');
  if (process.env.NODE_ENV === 'production' && !process.env.DB_SSL_CA && !isDigitalOcean) {
    logger.warn('DB_SSL_CA not provided in production. Database connections may not be secure.');
  }
};

// Database configuration with only valid MySQL2 options
const createDbConfig = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDigitalOcean = process.env.DB_HOST && process.env.DB_HOST.includes('digitalocean');
  
  const config = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    
    // Connection Pool Settings (valid for MySQL2)
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || (isProduction ? 20 : 10),
    queueLimit: 100,
    
    // Valid timeout settings
    waitForConnections: true,
    idleTimeout: 300000,
    maxIdle: 10,    

    // Character Set and Timezone
    charset: 'utf8mb4',
    timezone: '+08:00',
    
    // Number Handling
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    
    // Performance Settings
    typeCast: true,
    nestTables: false,
    rowsAsArray: false,
    
    // Additional valid settings
    multipleStatements: false,
    namedPlaceholders: false,
  };

  // Only add SSL in production
  if (isProduction) {
    if (isDigitalOcean) {
      config.ssl = {
        rejectUnauthorized: false
      };
    } else if (process.env.DB_SSL_CA) {
      config.ssl = {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
        ca: process.env.DB_SSL_CA,
        cert: process.env.DB_SSL_CERT,
        key: process.env.DB_SSL_KEY,
      };
    }
  }

  return config;
};

// Global variables
let pool = null;
let poolStats = {
  created: null,
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  connectionErrors: 0
};

// Initialize database pool
const initializeDatabase = async () => {
  try {
    validateConfig();
    
    if (pool) {
      logger.info('Database pool already initialized');
      return pool;
    }

    const dbConfig = createDbConfig();
    pool = mysql.createPool(dbConfig);
    
    // Set up pool event listeners
    pool.on('connection', (connection) => {
      logger.debug(`New database connection established: ${connection.threadId}`);
    });

    pool.on('error', (err) => {
      poolStats.connectionErrors++;
      logger.error('Database pool error:', err);
      
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        logger.info('Attempting to reconnect to database...');
      }
    });

    poolStats.created = new Date();
    logger.info('Database pool initialized successfully', {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      connectionLimit: dbConfig.connectionLimit
    });

    return pool;
  } catch (error) {
    logger.error('Failed to initialize database pool:', error);
    throw error;
  }
};

// Test database connection
const testConnection = async () => {
  try {
    if (!pool) {
      await initializeDatabase();
    }

    const startTime = Date.now();
    const connection = await pool.getConnection();
    
    try {
      await connection.execute('SELECT 1 as test, NOW() as timestamp');
      poolStats.successfulQueries++;
      
      const duration = Date.now() - startTime;
      logger.debug(`Database connection test successful (${duration}ms)`);
      
      return {
        success: true,
        duration,
        threadId: connection.threadId
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    poolStats.failedQueries++;
    logger.error('Database connection test failed:', error);
    throw new Error(`Database connection test failed: ${error.message}`);
  }
};

const getConnection = async () => {
  if (!pool) {
    await initializeDatabase();
  }
  return await pool.getConnection();
};


// Get detailed connection information
const getConnectionInfo = async () => {
  try {
    if (!pool) {
      await initializeDatabase();
    }

    const connection = await pool.getConnection();
    
    try {
      const [rows] = await connection.execute(`
        SELECT 
          CONNECTION_ID() as connection_id,
          DATABASE() as database_name,
          USER() as user,
          VERSION() as mysql_version,
          @@character_set_database as charset,
          @@time_zone as timezone
      `);

      poolStats.successfulQueries++;

      return {
        connectionId: rows[0].connection_id,
        database: rows[0].database_name,
        user: rows[0].user,
        mysqlVersion: rows[0].mysql_version,
        charset: rows[0].charset,
        timezone: rows[0].timezone,
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        ssl: process.env.NODE_ENV === 'production'
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    poolStats.failedQueries++;
    logger.error('Failed to get connection info:', error);
    throw error;
  }
};

// Get pool statistics
const getPoolStats = () => {
  if (!pool) {
    return { error: 'Database pool not initialized' };
  }

  const poolInfo = pool.pool || pool;
  
  return {
    ...poolStats,
    uptime: poolStats.created ? Date.now() - poolStats.created.getTime() : 0,
    connections: {
      total: poolInfo._allConnections?.length || 0,
      free: poolInfo._freeConnections?.length || 0,
      used: (poolInfo._allConnections?.length || 0) - (poolInfo._freeConnections?.length || 0),
      acquiring: poolInfo._acquiringConnections?.length || 0,
      limit: parseInt(process.env.DB_CONNECTION_LIMIT) || 50
    },
    config: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      environment: process.env.NODE_ENV || 'development'
    }
  };
};

// Execute query with error tracking and logging
const executeQuery = async (query, params = []) => {
  const startTime = Date.now();
  
  try {
    if (!pool) {
      await initializeDatabase();
    }

    const [results] = await pool.execute(query, params);
    
    poolStats.totalQueries++;
    poolStats.successfulQueries++;
    
    const duration = Date.now() - startTime;
    
    if (duration > 1000) { // Log slow queries
      logger.warn('Slow query detected', {
        query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
        duration,
        params: params.length
      });
    }

    return results;
  } catch (error) {
    poolStats.totalQueries++;
    poolStats.failedQueries++;
    
    logger.error('Query execution failed', {
      query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
      error: error.message,
      duration: Date.now() - startTime
    });
    
    throw error;
  }
};

// Close database pool with graceful shutdown
const closePool = async (timeout = 10000) => {
  if (!pool) {
    logger.info('No database pool to close');
    return;
  }

  try {
    logger.info('Closing database pool...');
    
    // Set a timeout for graceful shutdown
    const closePromise = pool.end();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Pool close timeout')), timeout);
    });

    await Promise.race([closePromise, timeoutPromise]);
    
    pool = null;
    logger.info('Database pool closed successfully');
  } catch (error) {
    logger.error('Error closing database pool:', error);
    
    // Force close if graceful shutdown fails
    try {
      await pool.destroy();
      pool = null;
      logger.warn('Database pool force closed');
    } catch (destroyError) {
      logger.error('Failed to force close pool:', destroyError);
    }
    
    throw error;
  }
};

// Get pool instance (with safety check)
const getPool = () => {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializeDatabase() first.');
  }
  return pool;
};

// Health check function for monitoring
const healthCheck = async () => {
  try {
    const connectionTest = await testConnection();
    const stats = getPoolStats();
    
    return {
      status: 'healthy',
      database: {
        connected: connectionTest.success,
        responseTime: connectionTest.duration,
        threadId: connectionTest.threadId
      },
      pool: {
        totalConnections: stats.connections.total,
        freeConnections: stats.connections.free,
        usedConnections: stats.connections.used,
        connectionLimit: stats.connections.limit,
        utilization: Math.round((stats.connections.used / stats.connections.limit) * 100)
      },
      metrics: {
        totalQueries: stats.totalQueries,
        successfulQueries: stats.successfulQueries,
        failedQueries: stats.failedQueries,
        errorRate: stats.totalQueries > 0 ? Math.round((stats.failedQueries / stats.totalQueries) * 100) : 0,
        uptime: stats.uptime
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

module.exports = {
  // Core functions
  initializeDatabase,
  testConnection,
  getConnectionInfo,
  closePool,
  getPool,
  executeQuery,
  
  // Monitoring and stats
  getPoolStats,
  healthCheck,
  getConnection,
  
  // Legacy support
  pool: () => getPool(),
  
  // Logger export for consistent logging
  logger
};