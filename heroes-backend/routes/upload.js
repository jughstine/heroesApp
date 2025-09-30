const express = require('express');
const multer = require('multer');
const { Client } = require('minio');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const router = express.Router();

// Set FFmpeg path using the npm package
try {
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (error) {
  console.error('❌ Failed to set FFmpeg path:', error.message);
}

// Promisify fs functions
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

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
    fileSize: 500 * 1024 * 1024, // 500MB limit for video files (before compression)
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
      'video/webm',
      'video/mkv',
      'video/wmv',
      'video/flv',
      // Documents (if needed)
      'application/pdf'
    ];
        
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${allowedMimes.join(', ')}`), false);
    }
  }
});

// Ensure temp directory exists
const ensureTempDir = async () => {
  const tempDir = path.join(__dirname, 'temp');
  try {
    await mkdir(tempDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  return tempDir;
};

// Test FFmpeg availability
const testFFmpeg = async () => {
  return new Promise((resolve, reject) => {
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.error('❌ FFmpeg test failed:', err.message);
        reject(err);
      } else {        
        // Check for x265 codec
        ffmpeg.getAvailableCodecs((err, codecs) => {
          if (err) {
            console.warn('⚠️ Could not check codecs:', err.message);
          } else {
            const hasX265 = codecs && codecs.libx265;
          }
          resolve(true);
        });
      }
    });
  });
};

// Test FFmpeg on startup
testFFmpeg().catch(error => {
  console.error('❌ FFmpeg not available - video compression disabled');
});

// Compress video to H.265 HEVC
const compressVideo = (inputPath, outputPath, options = {}) => {
  return new Promise((resolve, reject) => {
    const {
      quality = 28, // Better default for file size vs quality balance
      maxWidth = 1920,
      maxHeight = 1080,
      preset = 'medium', // Better balance of speed vs compression
      maintainQuality = true
    } = options;

    // First check if FFmpeg is available
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.error('❌ FFmpeg not available during compression');
        reject(new Error('FFmpeg not available'));
        return;
      }

      let ffmpegCommand = ffmpeg(inputPath)
        .videoCodec('libx265')
        .audioCodec('aac')
        .addOption('-crf', quality)
        .addOption('-preset', preset)
        .addOption('-tag:v', 'hvc1') // Better compatibility
        .addOption('-movflags', '+faststart') // Optimize for streaming
        .addOption('-pix_fmt', 'yuv420p'); // Ensure compatibility

      // Add advanced quality options if maintainQuality is true
      if (maintainQuality) {
        ffmpegCommand = ffmpegCommand
          .addOption('-x265-params', 'keyint=240:min-keyint=20:no-scenecut')
          .addOption('-profile:v', 'main')
          .addOption('-level:v', '4.0');
      }

      ffmpegCommand
        .size(`${maxWidth}x${maxHeight}`)
        .autopad()
        .on('start', (commandLine) => {
        })
        .on('progress', (progress) => {
          const percent = Math.round(progress.percent || 0);
          if (percent % 20 === 0 || percent > 90) {
          }
        })
        .on('end', () => {
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ FFmpeg compression error:', err.message);
          reject(new Error(`Video compression failed: ${err.message}`));
        })
        .save(outputPath);
    });
  });
};

// Check if file is a video
const isVideo = (mimetype) => {
  return mimetype.startsWith('video/');
};

// Upload file to DigitalOcean Spaces
router.post('/', upload.single('file'), async (req, res) => {
  let tempInputPath = null;
  let tempOutputPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file provided',
        message: 'No file provided' 
      });
    }

    const timestamp = Date.now();
    const folder = req.body.folder || 'uploads';
    let fileName = `${folder}/${timestamp}-${req.file.originalname}`;
    let fileBuffer = req.file.buffer;
    let finalSize = req.file.size;
    let finalMimetype = req.file.mimetype;
    let compressionAttempted = false;

    // Check if we should skip compression (already compressed on client)
    const skipCompression = req.body.skipCompression === 'true' || 
                           req.body.alreadyCompressed === 'true';

    // Process video files (only if not already compressed)
    if (isVideo(req.file.mimetype) && !skipCompression) {
      compressionAttempted = true;
      
      try {
        const tempDir = await ensureTempDir();
        const originalExt = path.extname(req.file.originalname);
        const baseName = path.basename(req.file.originalname, originalExt);
        
        // Create temp file paths
        tempInputPath = path.join(tempDir, `input-${timestamp}${originalExt}`);
        tempOutputPath = path.join(tempDir, `output-${timestamp}.mp4`);


        // Write input file to temp directory
        await writeFile(tempInputPath, req.file.buffer);

        // Parse compression options from request
        const compressionOptions = {};
        if (req.body.quality) compressionOptions.quality = parseInt(req.body.quality);
        if (req.body.maxWidth) compressionOptions.maxWidth = parseInt(req.body.maxWidth);
        if (req.body.maxHeight) compressionOptions.maxHeight = parseInt(req.body.maxHeight);
        if (req.body.preset) compressionOptions.preset = req.body.preset;
        if (req.body.maintainQuality !== undefined) compressionOptions.maintainQuality = req.body.maintainQuality === 'true';

        // Compress video
        await compressVideo(tempInputPath, tempOutputPath, compressionOptions);

        // Check if output file exists and has content
        if (!fs.existsSync(tempOutputPath)) {
          throw new Error('Compressed output file was not created');
        }

        const outputStats = fs.statSync(tempOutputPath);
        if (outputStats.size === 0) {
          throw new Error('Compressed output file is empty');
        }

        // Read compressed file
        fileBuffer = await fs.promises.readFile(tempOutputPath);
        finalSize = fileBuffer.length;
        finalMimetype = 'video/mp4';
        
        // Update filename to reflect H.265 compression
        fileName = `${folder}/${timestamp}-${baseName}-h265.mp4`;

        const reductionPercent = Math.round((1 - finalSize/req.file.size) * 100);        
      } catch (compressionError) {
        console.error('❌ Video compression failed:', compressionError.message);
        
        // If compression fails, upload original file
        fileBuffer = req.file.buffer;
        finalSize = req.file.size;
        finalMimetype = req.file.mimetype;
      }
    } else if (isVideo(req.file.mimetype) && skipCompression) {
      // Keep the original compressed buffer from client
      fileBuffer = req.file.buffer;
      finalSize = req.file.size;
      finalMimetype = req.file.mimetype;
    }

    // Upload to DigitalOcean Spaces
    await minioClient.putObject(
      process.env.SPACES_BUCKET,
      fileName,
      fileBuffer,
      finalSize,
      {
        'Content-Type': finalMimetype,
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
      finalFileName: path.basename(fileName),
      originalSize: req.file.size,
      finalSize: finalSize,
      compressionRatio: req.file.size !== finalSize ? Math.round((1 - finalSize/req.file.size) * 100) : 0,
      contentType: finalMimetype,
      originalContentType: req.file.mimetype,
      folder: folder,
      compressed: isVideo(req.file.mimetype) && finalSize < req.file.size,
      compressionAttempted: compressionAttempted,
      clientCompressed: skipCompression,
      ...metadata
    };

    res.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Upload error:', error);
    
    // Better error handling
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
  } finally {
    // Clean up temp files
    try {
      if (tempInputPath && fs.existsSync(tempInputPath)) {
        await unlink(tempInputPath);
      }
      if (tempOutputPath && fs.existsSync(tempOutputPath)) {
        await unlink(tempOutputPath);
      }
    } catch (cleanupError) {
      console.error('Temp file cleanup error:', cleanupError);
    }
  }
});

// Test endpoint for FFmpeg
router.get('/test-ffmpeg', (req, res) => {
  ffmpeg.getAvailableFormats((err, formats) => {
    if (err) {
      return res.json({
        success: false,
        error: 'FFmpeg not available',
        details: err.message
      });
    }
    
    ffmpeg.getAvailableCodecs((err, codecs) => {
      const hasX265 = codecs && codecs.libx265;
      
      res.json({
        success: true,
        data: {
          ffmpegAvailable: true,
          x265Available: !!hasX265,
          totalCodecs: Object.keys(codecs || {}).length,
          totalFormats: Object.keys(formats || {}).length,
          message: hasX265 ? 'H.265 compression ready' : 'x265 codec not available'
        }
      });
    });
  });
});

// Get compression status endpoint
router.get('/compression-info', (req, res) => {
  res.json({
    success: true,
    data: {
      supportedFormats: ['mp4', 'mov', 'avi', 'quicktime', 'webm', 'mkv', 'wmv', 'flv'],
      outputFormat: 'mp4 (H.265/HEVC)',
      defaultQuality: 28,
      qualityRange: '0-51 (lower = better quality)',
      defaultPreset: 'medium',
      presetOptions: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
      maxDimensions: '1920x1080',
      maxFileSize: '500MB'
    }
  });
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