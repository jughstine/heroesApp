const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { 
  initializeDatabase, 
  testConnection, 
  closePool 
} = require('./config/database');

const heroesRoutes = require('./routes/heroes');
const uploadRoutes = require('./routes/upload');
const usersRoutes = require('./routes/users');
const formsRoutes = require('./routes/forms');
const adminForms = require('./routes/admin_forms');
const { router: adminAuthRoutes } = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    // In development, be more permissive
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    // Production - specific origins only
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://www.afppgmc.com',
      'https://afppgmc.com',
      process.env.CORS_ORIGIN
    ].filter(Boolean); 
    
    // React Native specific origins
    const reactNativeOrigins = [
      'file://',
      'capacitor://localhost',
      'ionic://localhost',
      'http://localhost',
      'http://192.168.',
      'http://10.0.',
      'http://172.16.'
    ];
    
    // Check if origin matches React Native patterns
    const isReactNative = reactNativeOrigins.some(pattern => 
      origin.startsWith(pattern)
    );
    
    if (allowedOrigins.includes(origin) || isReactNative) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Add logging middleware to debug requests
app.use((req, res, next) => {
  next();
});

app.use(express.json({ limit: process.env.MAX_FILE_SIZE || '15mb' }));
app.use(express.urlencoded({ 
  extended: true, 
  limit: process.env.MAX_FILE_SIZE || '15mb' 
}));

// mobile app routes 
app.use('/api/heroes', heroesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/forms', formsRoutes);

// web 
app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin_forms', adminForms);

// Enhanced health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    let dbStatus = 'unknown';
    let dbError = null;
    
    try {
      await testConnection();
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'disconnected';
      dbError = error.message;
    }

    const healthData = {
      success: true,
      message: 'Server is running!',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.APP_VERSION || '1.0.0',
      server: {
        port: PORT,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        platform: process.platform,
        nodeVersion: process.version
      },
      services: {
        database: dbStatus,
        ...(dbError && { databaseError: dbError })
      },
      headers: {
        origin: req.headers.origin || 'none',
        userAgent: req.headers['user-agent'] || 'none'
      }
    };

    res.json(healthData);
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    success: false, 
    error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong!',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

const shutdown = async () => {
  try {
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
const startServer = async () => {
  try {
    await initializeDatabase();
    await testConnection();
    
    app.listen(PORT, '0.0.0.0', () => {
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
};

//
// test server
// 

app.get('/api/diagnostic/database', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const diagnostic = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      
      // Environment variables check
      environmentVariables: {
        DB_HOST: process.env.DB_HOST ? 'SET' : 'MISSING',
        DB_PORT: process.env.DB_PORT || '3306 (default)',
        DB_USER: process.env.DB_USER ? 'SET' : 'MISSING',
        DB_PASSWORD: process.env.DB_PASSWORD ? 'SET' : 'MISSING',
        DB_NAME: process.env.DB_NAME ? 'SET' : 'MISSING'
      },
      
      // Database configuration
      databaseConfig: {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        database: process.env.DB_NAME,
        ssl: false
      }
    };

    //  MySQL connection
    let connectionTest = {
      status: 'failed',
      error: null,
      duration: 0
    };

    try {
      const mysql = require('mysql2/promise');
      const testConfig = {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: false,
        connectTimeout: 5000
      };

      const testStart = Date.now();
      const connection = await mysql.createConnection(testConfig);
      
      try {
        const [rows] = await connection.execute('SELECT 1 as test, NOW() as timestamp, CONNECTION_ID() as conn_id, VERSION() as version');
        connectionTest = {
          status: 'success',
          duration: Date.now() - testStart,
          result: rows[0],
          connectionId: rows[0].conn_id,
          serverVersion: rows[0].version
        };
      } finally {
        await connection.end();
      }
    } catch (error) {
      connectionTest = {
        status: 'failed',
        duration: Date.now() - startTime,
        error: {
          code: error.code,
          errno: error.errno,
          sqlState: error.sqlState,
          message: error.message
        }
      };
    }

    // Pool connection test
    let poolTest = {
      status: 'failed',
      error: null
    };

    try {
      const { testConnection } = require('./config/database');
      const poolResult = await testConnection();
      poolTest = {
        status: 'success',
        ...poolResult
      };
    } catch (error) {
      poolTest = {
        status: 'failed',
        error: {
          code: error.code,
          message: error.message
        }
      };
    }

    // DNS resolution check
    let dnsTest = {
      status: 'unknown',
      error: null
    };

    if (process.env.DB_HOST) {
      try {
        const dns = require('dns').promises;
        const dnsStart = Date.now();
        const addresses = await dns.lookup(process.env.DB_HOST);
        dnsTest = {
          status: 'success',
          duration: Date.now() - dnsStart,
          resolved: addresses
        };
      } catch (error) {
        dnsTest = {
          status: 'failed',
          error: {
            code: error.code,
            message: error.message
          }
        };
      }
    }

    const totalDuration = Date.now() - startTime;

    res.json({
      success: true,
      message: 'Database diagnostic completed',
      totalDuration: `${totalDuration}ms`,
      diagnostic: {
        ...diagnostic,
        tests: {
          directConnection: connectionTest,
          poolConnection: poolTest,
          dnsResolution: dnsTest
        },
        summary: {
          canConnectDirectly: connectionTest.status === 'success',
          canConnectViaPool: poolTest.status === 'success',
          canResolveDNS: dnsTest.status === 'success',
          overallStatus: connectionTest.status === 'success' ? 'healthy' : 'unhealthy'
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Diagnostic test failed',
      details: {
        message: error.message,
        code: error.code,
        stack: error.stack
      },
      duration: `${Date.now() - startTime}ms`
    });
  }
});

// Network connectivity test endpoint
app.get('/api/diagnostic/network', async (req, res) => {
  try {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    
    res.json({
      success: true,
      serverInfo: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        networkInterfaces: Object.keys(networkInterfaces).reduce((acc, name) => {
          acc[name] = networkInterfaces[name].filter(iface => iface.family === 'IPv4');
          return acc;
        }, {})
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

//
// 

startServer();