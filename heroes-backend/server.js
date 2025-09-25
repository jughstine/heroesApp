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

// CORS configuration - FIXED: Only one CORS middleware with proper origin handling
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      process.env.CORS_ORIGIN
    ].filter(Boolean); // Remove any undefined values
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

app.use(cors(corsOptions));

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

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    let dbStatus = 'unknown';
    try {
      await testConnection();
      dbStatus = 'connected';
    } catch {
      dbStatus = 'disconnected';
    }

    res.json({
      success: true,
      message: 'Server is running!',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.APP_VERSION || '1.0.0',
      services: {
        database: dbStatus
      }
    });
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
    console.log('Database pool closed. Shutting down server...');
    process.exit(0);
  } catch {
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
      console.log(`✅ Server is running on port ${PORT} and connected to the database`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();