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

startServer();