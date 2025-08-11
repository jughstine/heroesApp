const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const AWS = require('aws-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// MySQL Connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false } // required for DigitalOcean DB
});

db.connect(err => {
  if (err) {
    console.error('❌ DB connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Connected to MySQL');
});

// Setup DigitalOcean Spaces client (S3 compatible)
const spacesEndpoint = new AWS.Endpoint(process.env.SPACES_ENDPOINT.replace('https://', ''));
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
});

// Simple test route
app.get('/', (req, res) => {
  res.send('Heroes backend is running!');
});

// Example route: fetch some data from DB
app.get('/pensioners', (req, res) => {
  db.query('SELECT * FROM heroes_tbl LIMIT 10', (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Database query error' });
    }
    res.json(results);
  });
});

// Example route: list objects in Spaces bucket
app.get('/spaces-files', async (req, res) => {
  try {
    const data = await s3.listObjectsV2({ Bucket: process.env.SPACES_BUCKET }).promise();
    res.json(data.Contents);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching spaces files' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
