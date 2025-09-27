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

  logger.info('Database configuration validated', {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || '3306',
    user: process.env.DB_USER,
    database: process.env.DB_NAME
  });
};

//  database config
const createDbConfig = () => {
  const config = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    
    // Connection Pool Settings - Conservative for stability
    connectionLimit: 10,
    queueLimit: 0,

    // Timeout settings
    waitForConnections: true,
    idleTimeout: 300000,        // 5 minutes
    maxIdle: 5,
    connectTimeout: 10000,      // 10 seconds
    
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
    multipleStatements: false,
    namedPlaceholders: false,
    
    // disable SSL
    ssl: false
  };

  logger.info('Database config created', {
    host: config.host,
    port: config.port,
    database: config.database,
    connectionLimit: config.connectionLimit,
    ssl: config.ssl
  });

  return config;
};

// Global variables
let pool = null;
let poolStats = {
  created: null,
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  connectionErrors: 0,
  retries: 0
};

// Initialize database with retry logic
const initializeDatabase = async (retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      validateConfig();
      
      if (pool) {
        logger.info('Database pool already initialized');
        return pool;
      }

      const dbConfig = createDbConfig();
      logger.info(`Database initialization attempt ${attempt}/${retries}`);

      pool = mysql.createPool(dbConfig);
      
      // Test connection immediately
      await testConnectionInternal();
      
      // Set up event listeners
      pool.on('connection', (connection) => {
        logger.info(`New database connection: ${connection.threadId}`);
      });

      pool.on('error', (err) => {
        poolStats.connectionErrors++;
        logger.error('Database pool error:', {
          code: err.code,
          message: err.message,
          errno: err.errno
        });
      });

      poolStats.created = new Date();
      logger.info('Database pool initialized successfully', { attempt });
      return pool;
    } catch (error) {
      logger.error(`Database init attempt ${attempt}/${retries} failed:`, {
        code: error.code,
        message: error.message
      });
      
      if (attempt === retries) {
        throw error;
      }
      
      // Wait before retry
      const waitTime = attempt * 2000;
      logger.info(`Retrying in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
};

// Internal test function
const testConnectionInternal = async () => {
  const connection = await pool.getConnection();
  try {
    await connection.execute('SELECT 1 as test');
    return true;
  } finally {
    connection.release();
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
      const [rows] = await connection.execute('SELECT 1 as test, NOW() as timestamp');
      poolStats.successfulQueries++;
      
      const duration = Date.now() - startTime;
      logger.debug(`Connection test successful (${duration}ms)`);
      
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
    logger.error('Connection test failed:', error);
    throw new Error(`Database connection test failed: ${error.message}`);
  }
};

// Enhanced executeQuery with retries
const executeQuery = async (query, params = [], retries = 1) => {
  const startTime = Date.now();
  poolStats.totalQueries++;
  
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (!pool) {
        await initializeDatabase();
      }

      const [results] = await pool.execute(query, params);
      poolStats.successfulQueries++;
      
      const duration = Date.now() - startTime;
      if (duration > 2000) {
        logger.warn('Slow query detected', { duration, query: query.substring(0, 50) });
      }

      return results;
    } catch (error) {
      const isConnectionError = [
        'PROTOCOL_CONNECTION_LOST',
        'ECONNRESET', 
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNREFUSED'
      ].includes(error.code);
      
      if (isConnectionError && attempt <= retries) {
        poolStats.retries++;
        logger.warn(`Retrying query due to connection error: ${error.code}`);
        
        // Reset pool
        if (pool) {
          try {
            await pool.end();
          } catch (e) {
            // Ignore close errors
          }
          pool = null;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      
      poolStats.failedQueries++;
      logger.error('Query failed permanently:', {
        code: error.code,
        message: error.message,
        query: query.substring(0, 50)
      });
      
      throw error;
    }
  }
};

// Get connection
const getConnection = async () => {
  if (!pool) {
    await initializeDatabase();
  }
  return await pool.getConnection();
};

// Pool statistics
const getPoolStats = () => {
  if (!pool) {
    return { error: 'Database pool not initialized', stats: poolStats };
  }

  const poolInfo = pool.pool || pool;
  
  return {
    ...poolStats,
    uptime: poolStats.created ? Date.now() - poolStats.created.getTime() : 0,
    connections: {
      total: poolInfo._allConnections?.length || 0,
      free: poolInfo._freeConnections?.length || 0,
      used: (poolInfo._allConnections?.length || 0) - (poolInfo._freeConnections?.length || 0),
      limit: 10
    },
    config: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      environment: process.env.NODE_ENV || 'development'
    }
  };
};

// Health check
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
        utilization: Math.round((stats.connections.used / 10) * 100)
      },
      metrics: {
        totalQueries: stats.totalQueries,
        successfulQueries: stats.successfulQueries,
        failedQueries: stats.failedQueries,
        retries: stats.retries,
        connectionErrors: stats.connectionErrors,
        errorRate: stats.totalQueries > 0 ? Math.round((stats.failedQueries / stats.totalQueries) * 100) : 0,
        uptime: stats.uptime
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      code: error.code,
      timestamp: new Date().toISOString()
    };
  }
};

// Get connection info
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
        ssl: false
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

// Close pool
const closePool = async (timeout = 5000) => {
  if (!pool) {
    logger.info('No database pool to close');
    return;
  }

  try {
    logger.info('Closing database pool...');
    await Promise.race([
      pool.end(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Close timeout')), timeout))
    ]);
    
    pool = null;
    logger.info('Database pool closed successfully');
  } catch (error) {
    logger.error('Error closing pool:', error);
    try {
      await pool.destroy();
      pool = null;
    } catch (destroyError) {
      logger.error('Failed to destroy pool:', destroyError);
    }
  }
};

// Get pool instance
const getPool = () => {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initializeDatabase() first.');
  }
  return pool;
};

module.exports = {
  initializeDatabase,
  testConnection,
  getConnectionInfo,
  closePool,
  getPool,
  executeQuery,
  getConnection,
  getPoolStats,
  healthCheck,
  pool: () => getPool(),
  logger
};