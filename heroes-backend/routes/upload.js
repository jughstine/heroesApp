const express = require('express');
const multer = require('multer');
const { Client } = require('minio');
const router = express.Router();

// Configure DigitalOcean Spaces client (S3-compatible)
const minioClient = new Client({
  endPoint: process.env.SPACES_ENDPOINT.replace('https://', ''),
  port: 443,
  useSSL: true,
  accessKey: process.env.SPACES_KEY,
  secretKey: process.env.SPACES_SECRET,
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg','image/jpg','image/png','image/gif','image/webp'];
    if (allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Only images are allowed.'), false);
  }
});

// Upload file to DigitalOcean Spaces
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: 'No file provided' });

    const timestamp = Date.now();
    const fileName = `heroes/${timestamp}-${req.file.originalname}`;

    await minioClient.putObject(
      process.env.SPACES_BUCKET,
      fileName,
      req.file.buffer,
      req.file.size,
      {
        'Content-Type': req.file.mimetype,
        'x-amz-acl': 'public-read'
      }
    );

    const publicUrl = `https://${process.env.SPACES_BUCKET}.sgp1.digitaloceanspaces.com/${fileName}`;
    res.json({
      success: true,
      data: {
        url: publicUrl,
        key: fileName,
        fileName: req.file.originalname,
        size: req.file.size,
        contentType: req.file.mimetype
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete file from DigitalOcean Spaces
router.delete('/:key(*)', async (req, res) => {
  try {
    const { key } = req.params;
    if (!key)
      return res.status(400).json({ success: false, message: 'File key is required' });

    await minioClient.removeObject(process.env.SPACES_BUCKET, decodeURIComponent(key));
    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
