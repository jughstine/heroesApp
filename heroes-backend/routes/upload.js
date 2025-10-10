const express = require('express');
const multer = require('multer');
const { Client } = require('minio');
const { getPool } = require('../config/database');
const router = express.Router();

const minioClient = new Client({
  endPoint: process.env.SPACES_ENDPOINT.replace('https://', ''),
  port: 443,
  useSSL: true,
  accessKey: process.env.SPACES_KEY,
  secretKey: process.env.SPACES_SECRET,
});

// Database connection health check (same as your other routes)
const checkDatabaseHealth = async () => {
  try {
    const pool = getPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
};

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
  const startTime = Date.now();
  let conn = null;

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

    res.json({
      success: true,
      data: responseData,
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('? Upload error:', error);
    
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ 
          success: false, 
          error: 'File too large. Maximum size is 500MB.',
          processingTime: `${processingTime}ms`
        });
      }
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Upload failed',
      processingTime: `${processingTime}ms`
    });
  }
});

// Delete file from DigitalOcean Spaces
router.delete('/:key(*)', async (req, res) => {
  const startTime = Date.now();

  try {
    const { key } = req.params;
    if (!key) {
      return res.status(400).json({ 
        success: false, 
        error: 'File key is required',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    await minioClient.removeObject(
      process.env.SPACES_BUCKET, 
      decodeURIComponent(key)
    );
    
    res.json({ 
      success: true, 
      message: 'File deleted successfully',
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Delete error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Delete failed',
      processingTime: `${processingTime}ms`
    });
  }
});

// Get file info endpoint
router.get('/info/:key(*)', async (req, res) => {
  const startTime = Date.now();

  try {
    const { key } = req.params;
    if (!key) {
      return res.status(400).json({ 
        success: false, 
        error: 'File key is required',
        processingTime: `${Date.now() - startTime}ms`
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
      },
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('File info error:', error);
    res.status(404).json({ 
      success: false, 
      error: 'File not found or inaccessible',
      processingTime: `${processingTime}ms`
    });
  }
});

// ========== ANNOUNCEMENTS ===========

// GET all active announcements (for mobile app)
router.get('/announcements', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();
    
    const [rows] = await conn.execute(
      `SELECT id, title, description, image_url, link_url, is_active, 
              display_order, created_at, updated_at
       FROM announcements 
       WHERE is_active = true 
       ORDER BY display_order ASC, created_at DESC`
    );
    
    res.json({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching announcements:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch announcements',
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// GET all announcements (for admin panel)
router.get('/admin/announcements', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();
    
    const [rows] = await conn.execute(
      `SELECT id, title, description, image_url, link_url, is_active, 
              display_order, created_at, updated_at
       FROM announcements 
       ORDER BY display_order ASC, created_at DESC`
    );
    
    res.json({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error fetching announcements:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch announcements',
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// POST create new announcement
router.post('/admin/announcements', upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const { title, description, link_url, is_active, display_order } = req.body;
    let image_url = null;
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();
    
    // Upload image to DigitalOcean Spaces if provided
    if (req.file) {
      const timestamp = Date.now();
      const fileName = `announcements/${timestamp}-${req.file.originalname}`;
            
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
    }
    
    const [result] = await conn.execute(
      `INSERT INTO announcements 
       (title, description, image_url, link_url, is_active, display_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        title,
        description || null,
        image_url,
        link_url || null,
        is_active === 'true' || is_active === true,
        display_order || 0
      ]
    );
    
    // Fetch the created announcement
    const [announcement] = await conn.execute(
      'SELECT * FROM announcements WHERE id = ?',
      [result.insertId]
    );
    
    res.json({
      success: true,
      data: announcement[0],
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error creating announcement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create announcement',
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// PUT update announcement
router.put('/admin/announcements/:id', upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const { id } = req.params;
    const { title, description, link_url, is_active, display_order } = req.body;
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();
    
    // Get existing announcement
    const [existing] = await conn.execute(
      'SELECT image_url FROM announcements WHERE id = ?',
      [id]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    let image_url = existing[0].image_url;
    
    // If new image uploaded, delete old one and upload new
    if (req.file) {
      // Delete old image from Spaces if it exists
      if (image_url) {
        try {
          const oldKey = image_url.split('.digitaloceanspaces.com/')[1];
          if (oldKey) {
            await minioClient.removeObject(process.env.SPACES_BUCKET, oldKey);
          }
        } catch (err) {
          console.error('Error deleting old image:', err);
        }
      }
      
      // Upload new image
      const timestamp = Date.now();
      const fileName = `announcements/${timestamp}-${req.file.originalname}`;
            
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
    }
    
    const [result] = await conn.execute(
      `UPDATE announcements 
       SET title = ?, description = ?, image_url = ?, 
           link_url = ?, is_active = ?, display_order = ?, 
           updated_at = NOW()
       WHERE id = ?`,
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

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    // Fetch the updated announcement
    const [announcement] = await conn.execute(
      'SELECT * FROM announcements WHERE id = ?',
      [id]
    );
    
    res.json({
      success: true,
      data: announcement[0],
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error updating announcement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update announcement',
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// DELETE announcement
router.delete('/admin/announcements/:id', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const { id } = req.params;
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();
    
    // Get image path before deleting
    const [result] = await conn.execute(
      'SELECT image_url FROM announcements WHERE id = ?',
      [id]
    );
    
    if (result.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    // Delete the image from Spaces if it exists
    const image_url = result[0].image_url;
    if (image_url) {
      try {
        const key = image_url.split('.digitaloceanspaces.com/')[1];
        if (key) {
          await minioClient.removeObject(process.env.SPACES_BUCKET, key);
        }
      } catch (err) {
        console.error('Error deleting image from Spaces:', err);
      }
    }
    
    // Delete from database
    const [deleteResult] = await conn.execute('DELETE FROM announcements WHERE id = ?', [id]);
    
    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    res.json({
      success: true,
      message: 'Announcement deleted successfully',
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error deleting announcement:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete announcement',
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

// PATCH toggle active status
router.patch('/admin/announcements/:id/toggle', async (req, res) => {
  const startTime = Date.now();
  let conn = null;

  try {
    const { id } = req.params;
    
    // Database health check
    const dbHealthy = await checkDatabaseHealth();
    if (!dbHealthy) {
      return res.status(503).json({
        success: false,
        error: "Database service temporarily unavailable. Please try again later.",
        code: 'DB_UNAVAILABLE',
        processingTime: `${Date.now() - startTime}ms`
      });
    }

    const pool = getPool();
    conn = await pool.getConnection();
    
    const [result] = await conn.execute(
      `UPDATE announcements 
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = ?`,
      [id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Announcement not found',
        code: 'NOT_FOUND',
        processingTime: `${Date.now() - startTime}ms`
      });
    }
    
    // Fetch the updated announcement
    const [announcement] = await conn.execute(
      'SELECT * FROM announcements WHERE id = ?',
      [id]
    );
    
    res.json({
      success: true,
      data: announcement[0],
      meta: {
        processingTime: `${Date.now() - startTime}ms`
      }
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Error toggling announcement status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle announcement status',
      code: 'SERVER_ERROR',
      processingTime: `${processingTime}ms`
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseError) {
        console.error("Connection release error:", releaseError);
      }
    }
  }
});

module.exports = router;