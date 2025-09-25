const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionLimit: 10,
  connectTimeout: 60000
  
};

let pool = null;

const initializeDatabase = async () => {
  try {
    if (!pool) {
      pool = mysql.createPool(dbConfig);
    }
  } catch (error) {
    throw error;
  }
};

const testConnection = async () => {
  try {
    if (!pool) {
      await initializeDatabase();
    }
    const connection = await pool.getConnection();
    await connection.execute('SELECT 1 as test');
    connection.release();
    return true;
  } catch (error) {
    throw error;
  }
};

const getConnectionInfo = async () => {
  try {
    if (!pool) {
      await initializeDatabase();
    }
    const connection = await pool.getConnection();
    const [rows] = await connection.execute('SELECT CONNECTION_ID() as connection_id, DATABASE() as database_name, USER() as user');
    connection.release();
    
    return {
      connectionId: rows[0].connection_id,
      database: rows[0].database_name,
      user: rows[0].user,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306
    };
  } catch (error) {
    throw error;
  }
};

const closePool = async () => {
  try {
    if (pool) {
      await pool.end();
      pool = null;
    }
  } catch (error) {
    throw error;
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
  pool: () => getPool()
};