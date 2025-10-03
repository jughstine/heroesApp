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
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/mov', 'video/avi', 'video/quicktime', 
      'video/webm', 'video/mkv', 'video/wmv', 'video/flv',
      'application/pdf'
    ];
        
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`), false);
    }
  }
});

// Upload file to DigitalOcean Spaces
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file provided' 
      });
    }

    const timestamp = Date.now();
    const folder = req.body.folder || 'uploads';
    const fileName = `${folder}/${timestamp}-${req.file.originalname}`;

    // Parse metadata FIRST, before using it
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    // Check if video is already compressed by client
    const isPreCompressed = req.body.isPreCompressed === 'true' || 
                           req.body.alreadyCompressed === 'true' ||
                           req.body.skipCompression === 'true';

    console.log('Upload details:', {
      fileName: req.file.originalname,
      size: (req.file.size / 1024 / 1024).toFixed(2) + ' MB',
      isPreCompressed,
      folder,
      metadata
    });

    // For pre-compressed videos, upload directly without server-side compression
    if (isPreCompressed) {
      console.log('📤 Uploading pre-compressed video directly to storage...');
    }

    // Upload to DigitalOcean Spaces with proper metadata
    const uploadMetadata = {
      'Content-Type': req.file.mimetype,
      'x-amz-acl': 'public-read',
      'x-amz-meta-original-name': req.file.originalname,
      'x-amz-meta-upload-timestamp': timestamp.toString()
    };

    // Add compression metadata if provided
    if (metadata.clientCompressed) {
      uploadMetadata['x-amz-meta-client-compressed'] = 'true';
      uploadMetadata['x-amz-meta-compression-quality'] = metadata.compressionQuality || 'unknown';
      if (metadata.originalSize) {
        uploadMetadata['x-amz-meta-original-size'] = metadata.originalSize.toString();
      }
      if (metadata.compressionRatio) {
        uploadMetadata['x-amz-meta-compression-ratio'] = metadata.compressionRatio.toString();
      }
    }

    await minioClient.putObject(
      process.env.SPACES_BUCKET,
      fileName,
      req.file.buffer,
      req.file.size,
      uploadMetadata
    );

    const publicUrl = `https://${process.env.SPACES_BUCKET}.sgp1.digitaloceanspaces.com/${fileName}`;
    
    const responseData = {
      url: publicUrl,
      key: fileName,
      fileName: req.file.originalname,
      size: req.file.size,
      contentType: req.file.mimetype,
      folder: folder,
      preCompressed: isPreCompressed,
      ...metadata
    };

    console.log('✅ Upload successful:', {
      url: publicUrl,
      size: (req.file.size / 1024 / 1024).toFixed(2) + ' MB'
    });

    res.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Upload error:', error);
    
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          success: false, 
          error: 'File too large. Maximum size is 500MB.' 
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
        error: 'File key is required' 
      });
    }

    await minioClient.removeObject(
      process.env.SPACES_BUCKET, 
      decodeURIComponent(key)
    );
    
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

// Get file info endpoint
router.get('/info/:key(*)', async (req, res) => {
  try {
    const { key } = req.params;
    if (!key) {
      return res.status(400).json({ 
        success: false, 
        error: 'File key is required' 
      });
    }

    const stat = await minioClient.statObject(
      process.env.SPACES_BUCKET, 
      decodeURIComponent(key)
    );
    
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