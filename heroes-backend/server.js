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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: process.env.MAX_FILE_SIZE || '10mb' }));
app.use(express.urlencoded({ 
  extended: true, 
  limit: process.env.MAX_FILE_SIZE || '10mb' 
}));

app.use('/api/heroes', heroesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/forms', formsRoutes);

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

const gracefulShutdown = async () => {
  try {
    await closePool();
    console.log('Database pool closed. Shutting down server...');
    process.exit(0);
  } catch {
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

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
