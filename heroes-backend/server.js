const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { testConnection } = require('./config/database');
const heroesRoutes = require('./routes/heroes');
const uploadRoutes = require('./routes/upload');
const usersRoutes = require('./routes/users');
const formsRoutes = require('./routes/forms'); 

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*', // allow all for development
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/heroes', heroesRoutes);
app.use('/api/user', heroesRoutes);  // Add this line
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/forms', formsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Server is running!' });
});

// Test database connection
app.get('/api/test-db', async (req, res) => {
  try {
    await testConnection();
    res.json({ success: true, message: 'Database connection successful' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  testConnection();
});