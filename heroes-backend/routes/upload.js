const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const router = express.Router();

// Configure DigitalOcean Spaces
const spacesEndpoint = new AWS.Endpoint(process.env.SPACES_ENDPOINT);
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.SPACES_KEY,
  secretAccessKey: process.env.SPACES_SECRET,
  region: 'sgp1'
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // limit
  }
});

// Upload file to DigitalOcean Spaces
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }

    const fileName = `heroes/${Date.now()}-${req.file.originalname}`;
    
    const params = {
      Bucket: process.env.SPACES_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ACL: 'public-read',
      ContentType: req.file.mimetype,
    };

    const result = await s3.upload(params).promise();
    
    res.json({
      success: true,
      data: {
        url: result.Location,
        key: result.Key,
        fileName: req.file.originalname,
        size: req.file.size
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete file from DigitalOcean Spaces
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    const params = {
      Bucket: process.env.SPACES_BUCKET,
      Key: decodeURIComponent(key),
    };

    await s3.deleteObject(params).promise();
    
    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;