const express = require('express');
const multer = require('multer');
const { Client } = require('minio');
const router = express.Router();

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
    fileSize: 20 * 1024 * 1024, // 20MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      // Images
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      // Videos
      'video/mp4',
      'video/mov',
      'video/avi',
      'video/quicktime',
      // Documents (if needed)
      'application/pdf'
    ];
    
    console.log('File MIME type:', file.mimetype); // Debug log
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${allowedMimes.join(', ')}`), false);
    }
  }
});

// Upload file to DigitalOcean Spaces
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file provided',
        message: 'No file provided' 
      });
    }

    console.log('Uploading file:', {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      folder: req.body.folder || 'default'
    });

    const timestamp = Date.now();
    const folder = req.body.folder || 'uploads'; // Use folder from request or default
    const fileName = `${folder}/${timestamp}-${req.file.originalname}`;

    // Upload to DigitalOcean Spaces
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
    
    // Include metadata if provided
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
    
    const responseData = {
      url: publicUrl,
      key: fileName,
      fileName: req.file.originalname,
      size: req.file.size,
      contentType: req.file.mimetype,
      folder: folder,
      ...metadata // Include any additional metadata
    };

    console.log('Upload successful:', responseData);

    res.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    
    // Better error handling
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          success: false, 
          error: 'File too large. Maximum size is 20MB.' 
        });
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Upload failed'
    });
  }
});

// Delete file from DigitalOcean Spaces
router.delete('/:key(*)', async (req, res) => {
  try {
    const { key } = req.params;
    if (!key) {
      return res.status(400).json({ 
        success: false, 
        error: 'File key is required',
        message: 'File key is required' 
      });
    }

    await minioClient.removeObject(process.env.SPACES_BUCKET, decodeURIComponent(key));
    
    res.json({ 
      success: true, 
      message: 'File deleted successfully' 
    });
    
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Delete failed'
    });
  }
});

// Get file info endpoint (optional, but useful for debugging)
router.get('/info/:key(*)', async (req, res) => {
  try {
    const { key } = req.params;
    if (!key) {
      return res.status(400).json({ 
        success: false, 
        error: 'File key is required' 
      });
    }

    const stat = await minioClient.statObject(process.env.SPACES_BUCKET, decodeURIComponent(key));
    
    res.json({
      success: true,
      data: {
        key: key,
        size: stat.size,
        contentType: stat.metaData['content-type'],
        lastModified: stat.lastModified,
        etag: stat.etag
      }
    });
    
  } catch (error) {
    console.error('File info error:', error);
    res.status(404).json({ 
      success: false, 
      error: 'File not found or inaccessible'
    });
  }
});

module.exports = router;