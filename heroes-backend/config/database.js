const mysql = require('mysql2/promise');
const winston = require('winston');
require('dotenv').config();

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

const validateConfig = () => {
  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

const createDbConfig = () => {
  const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT) || 10;
  
  const maxIdle = Math.max(Math.floor(connectionLimit * 0.5), 2);
  
  const config = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    
    connectionLimit: connectionLimit,
    queueLimit: 0,

    waitForConnections: true,
    idleTimeout: 300000,       
    maxIdle: maxIdle,
    connectTimeout: 10000,    
    
    charset: 'utf8mb4',
    timezone: 'Z',    
    
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    
    typeCast: true,
    nestTables: false,
    rowsAsArray: false,
    multipleStatements: false,
    namedPlaceholders: false,
    ssl: false
  };
  
  return config;
};

let pool = null;
let poolStats = {
  created: null,
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  connectionErrors: 0,
  retries: 0
};

const initializeDatabase = async (retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      validateConfig();
      
      if (pool) {
        logger.info('Database pool already initialized');
        return pool;
      }

      const dbConfig = createDbConfig();

      pool = mysql.createPool(dbConfig);
      
      await testConnectionInternal();
      
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
      return pool;
    } catch (error) {
      logger.error(`Database init attempt ${attempt}/${retries} failed:`, {
        code: error.code,
        message: error.message
      });
      
      if (attempt === retries) {
        throw error;
      }
      
      const waitTime = attempt * 2000;
      logger.info(`Retrying in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
};

const testConnectionInternal = async () => {
  const connection = await pool.getConnection();
  try {
    await connection.execute('SELECT 1 as test');
    return true;
  } finally {
    connection.release();
  }
};

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
        
        if (pool) {
          try {
            await pool.end();
          } catch (e) {
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

const getConnection = async () => {
  if (!pool) {
    await initializeDatabase();
  }
  return await pool.getConnection();
};

const getPoolStats = () => {
  if (!pool) {
    return { error: 'Database pool not initialized', stats: poolStats };
  }

  const poolInfo = pool.pool || pool;
  const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT) || 10;
  
  return {
    ...poolStats,
    uptime: poolStats.created ? Date.now() - poolStats.created.getTime() : 0,
    connections: {
      total: poolInfo._allConnections?.length || 0,
      free: poolInfo._freeConnections?.length || 0,
      used: (poolInfo._allConnections?.length || 0) - (poolInfo._freeConnections?.length || 0),
      limit: connectionLimit
    },
    config: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      environment: process.env.NODE_ENV || 'development'
    }
  };
};

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
        limit: stats.connections.limit,
        utilization: Math.round((stats.connections.used / stats.connections.limit) * 100)
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
        ssl: false,
        connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10
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