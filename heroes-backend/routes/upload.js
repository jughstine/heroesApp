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
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
  storage: multer.memoryStorage(),
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

// ========== ADVISORY ===========

// GET all active announcements (for mobile app)
router.get('/announcements', async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT id, title, description, image_url, link_url, is_active, 
              display_order, created_at, updated_at
       FROM announcements 
       WHERE is_active = true 
       ORDER BY display_order ASC, created_at DESC`
    );
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch announcements'
    });
  }
});

// GET all announcements (for admin panel)
router.get('/admin/announcements', async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT id, title, description, image_url, link_url, is_active, 
              display_order, created_at, updated_at
       FROM announcements 
       ORDER BY display_order ASC, created_at DESC`
    );
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch announcements'
    });
  }
});

// POST create new announcement
router.post('/admin/announcements', upload.single('image'), async (req, res) => {
  try {
    const { title, description, link_url, is_active, display_order } = req.body;
    let image_url = null;
    
    // Upload image to DigitalOcean Spaces if provided
    if (req.file) {
      const timestamp = Date.now();
      const fileName = `announcements/${timestamp}-${req.file.originalname}`;
      
      console.log('📤 Uploading announcement image:', fileName);
      
      await minioClient.putObject(
        process.env.SPACES_BUCKET,
        fileName,
        req.file.buffer,
        req.file.size,
        {
          'Content-Type': req.file.mimetype,
          'x-amz-acl': 'public-read',
          'x-amz-meta-original-name': req.file.originalname,
          'x-amz-meta-upload-timestamp': timestamp.toString()
        }
      );
      
      image_url = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_REGION || 'sgp1'}.digitaloceanspaces.com/${fileName}`;
      console.log('✅ Image uploaded:', image_url);
    }
    
    const result = await req.db.query(
      `INSERT INTO announcements 
       (title, description, image_url, link_url, is_active, display_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        title,
        description || null,
        image_url,
        link_url || null,
        is_active === 'true' || is_active === true,
        display_order || 0
      ]
    );
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create announcement'
    });
  }
});

// PUT update announcement
router.put('/admin/announcements/:id', upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, link_url, is_active, display_order } = req.body;
    
    // Get existing announcement
    const existing = await req.db.query(
      'SELECT image_url FROM announcements WHERE id = $1',
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found'
      });
    }
    
    let image_url = existing.rows[0].image_url;
    
    // If new image uploaded, delete old one and upload new
    if (req.file) {
      // Delete old image from Spaces if it exists
      if (image_url) {
        try {
          const oldKey = image_url.split('.digitaloceanspaces.com/')[1];
          if (oldKey) {
            await minioClient.removeObject(process.env.SPACES_BUCKET, oldKey);
            console.log('🗑️ Deleted old image:', oldKey);
          }
        } catch (err) {
          console.error('Error deleting old image:', err);
        }
      }
      
      // Upload new image
      const timestamp = Date.now();
      const fileName = `announcements/${timestamp}-${req.file.originalname}`;
      
      console.log('📤 Uploading new announcement image:', fileName);
      
      await minioClient.putObject(
        process.env.SPACES_BUCKET,
        fileName,
        req.file.buffer,
        req.file.size,
        {
          'Content-Type': req.file.mimetype,
          'x-amz-acl': 'public-read',
          'x-amz-meta-original-name': req.file.originalname,
          'x-amz-meta-upload-timestamp': timestamp.toString()
        }
      );
      
      image_url = `https://${process.env.SPACES_BUCKET}.${process.env.SPACES_REGION || 'sgp1'}.digitaloceanspaces.com/${fileName}`;
      console.log('✅ New image uploaded:', image_url);
    }
    
    const result = await req.db.query(
      `UPDATE announcements 
       SET title = $1, description = $2, image_url = $3, 
           link_url = $4, is_active = $5, display_order = $6, 
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [
        title,
        description || null,
        image_url,
        link_url || null,
        is_active === 'true' || is_active === true,
        display_order || 0,
        id
      ]
    );
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating announcement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update announcement'
    });
  }
});

// DELETE announcement
router.delete('/admin/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get image path before deleting
    const result = await req.db.query(
      'SELECT image_url FROM announcements WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found'
      });
    }
    
    // Delete the image from Spaces if it exists
    const image_url = result.rows[0].image_url;
    if (image_url) {
      try {
        const key = image_url.split('.digitaloceanspaces.com/')[1];
        if (key) {
          await minioClient.removeObject(process.env.SPACES_BUCKET, key);
          console.log('🗑️ Deleted image from Spaces:', key);
        }
      } catch (err) {
        console.error('Error deleting image from Spaces:', err);
      }
    }
    
    // Delete from database
    await req.db.query('DELETE FROM announcements WHERE id = $1', [id]);
    
    res.json({
      success: true,
      message: 'Announcement deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete announcement'
    });
  }
});

// PATCH toggle active status
router.patch('/admin/announcements/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await req.db.query(
      `UPDATE announcements 
       SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error toggling announcement status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle announcement status'
    });
  }
});


module.exports = router;