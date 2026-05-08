const { S3Client } = require("@aws-sdk/client-s3");

// ─── Singleton S3 clients ─────────────────────────────────────────────────────
// Instantiated once at startup; reused across all routes and workers.

let _psaBucket = null;
let _psaPgmcBucket = null;

/**
 * AWS S3 bucket (legacy PSA source bucket).
 */
function getPsaBucketClient() {
  if (_psaBucket) return _psaBucket;

  _psaBucket = new S3Client({
    region: "ap-southeast-1",
    credentials: {
      accessKeyId: process.env.PSA_KEY,
      secretAccessKey: process.env.PSA_SECRET,
    },
  });

  return _psaBucket;
}

/**
 * DigitalOcean Spaces bucket (PSA PGMC working bucket).
 */
function getPsaPgmcBucketClient() {
  if (_psaPgmcBucket) return _psaPgmcBucket;

  let endpoint =
    process.env.SPACES_ENDPOINT || "https://sgp1.digitaloceanspaces.com";
  if (!endpoint.startsWith("http")) endpoint = `https://${endpoint}`;
  endpoint = endpoint.replace(/\/$/, "");

  if (!process.env.SPACES_KEY || !process.env.SPACES_SECRET) {
    throw new Error(
      "Missing S3 credentials — SPACES_KEY and SPACES_SECRET must be set",
    );
  }

  _psaPgmcBucket = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
    },
    forcePathStyle: false,
  });

  return _psaPgmcBucket;
}

/**
 * Build the public-style file URL for a Spaces object key.
 * Uses SPACES_ENDPOINT env var so it's consistent everywhere.
 */
function buildSpacesFileUrl(key) {
  const endpoint = (
    process.env.SPACES_ENDPOINT || "https://sgp1.digitaloceanspaces.com"
  ).replace("https://", "");
  return `https://${process.env.SPACES_BUCKET}.${endpoint}/${key}`;
}

module.exports = {
  getPsaBucketClient,
  getPsaPgmcBucketClient,
  buildSpacesFileUrl,
};
