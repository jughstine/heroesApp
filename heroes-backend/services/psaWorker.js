const { getPool } = require("../config/database");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

// ─── S3 Clients ───────────────────────────────────────────────────────────────

function getS3Client() {
  const accessKeyId = process.env.SPACES_KEY;
  const secretAccessKey = process.env.SPACES_SECRET;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Missing S3 credentials — SPACES_KEY: ${!!accessKeyId}, SPACES_SECRET: ${!!secretAccessKey}`,
    );
  }

  return new S3Client({
    endpoint: "https://sgp1.digitaloceanspaces.com",
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });
}

function getPsaPgmcClient() {
  const accessKeyId = process.env.SPACES_KEY;
  const secretAccessKey = process.env.SPACES_SECRET;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Missing S3 credentials — SPACES_KEY: ${!!accessKeyId}, SPACES_SECRET: ${!!secretAccessKey}`,
    );
  }

  return new S3Client({
    endpoint: process.env.SPACES_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function uploadPsaPdf(referenceNumber, pdfBuffer) {
  const s3 = getS3Client();
  const key = `PSA/${referenceNumber}.pdf`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
    }),
  );

  const fileUrl = `https://${process.env.SPACES_BUCKET}/${key}`;
  return { key, fileUrl };
}

// ─── Poller ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10 * 1000;
const PSA_FOLDER = "PSA/";

async function pollSpacesForNewFiles() {
  const pool = getPool();

  try {
    const files = [];
    let continuationToken = undefined;

    do {
      const data = await getPsaPgmcClient().send(
        new ListObjectsV2Command({
          Bucket: process.env.SPACES_BUCKET,
          Prefix: PSA_FOLDER,
          ContinuationToken: continuationToken,
        }),
      );
      files.push(...(data.Contents || []));
      continuationToken = data.IsTruncated
        ? data.NextContinuationToken
        : undefined;
    } while (continuationToken);

    const pdfs = files.filter(
      (f) => f.Key.endsWith(".pdf") && f.Key !== PSA_FOLDER,
    );

    if (pdfs.length === 0) {
      console.log("📂 PSA poller — no PDFs found in Spaces");
      return;
    }

    console.log(`📂 PSA poller — found ${pdfs.length} PDF(s) in Spaces`);

    // ── Bulk fetch all known reference numbers in 2 queries ──
    const [existingJobRows] = await pool.execute(
      `SELECT reference_number FROM psa_processing_jobs`,
    );
    const [existingDocRows] = await pool.execute(
      `SELECT reference_number FROM psa_documents`,
    );

    const jobSet = new Set(existingJobRows.map((r) => r.reference_number));
    const docSet = new Set(existingDocRows.map((r) => r.reference_number));

    console.log(
      `📊 PSA poller — ${jobSet.size} jobs, ${docSet.size} docs in DB`,
    );

    for (const pdf of pdfs) {
      const referenceNumber = pdf.Key.replace(/^PSA\//, "").replace(
        /\.pdf$/,
        "",
      );

      if (!referenceNumber) {
        console.log(`⚠️ Empty reference number for key: ${pdf.Key}`);
        continue;
      }

      if (jobSet.has(referenceNumber)) continue;

      if (docSet.has(referenceNumber)) {
        console.log(
          `⏭️  PSA poller — ${referenceNumber} already in psa_documents, skipping`,
        );
        continue;
      }

      // No job AND no doc
      console.log(
        `🔍 No job, no doc — creating job for: "${referenceNumber}" (key: ${pdf.Key})`,
      );

      await pool.execute(
        `INSERT INTO psa_processing_jobs
          (reference_number, status, attempts, created_at, updated_at)
         VALUES (?, 'pending', 0, NOW(), NOW())`,
        [referenceNumber],
      );

      console.log(`✅ PSA poller — created job for: ${referenceNumber}`);
    }
  } catch (err) {
    console.error("❌ PSA poller error:", err);
  }
}
// ─── Worker ───────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const CONCURRENCY = 10;

async function processNextPsaJob() {
  const pool = getPool();
  let conn = null;

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [jobs] = await conn.execute(
      `SELECT * 
       FROM psa_processing_jobs
       WHERE 
         (status = 'pending' AND attempts < ?)
         OR (status = 'processing' AND updated_at < NOW() - INTERVAL 5 MINUTE)
       ORDER BY id ASC
       LIMIT ${CONCURRENCY}
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS],
    );

    if (jobs.length === 0) {
      await conn.rollback();
      conn.release();
      conn = null;
      return false;
    }

    // Claim ALL jobs at once
    const ids = jobs.map((j) => j.id);
    await conn.execute(
      `UPDATE psa_processing_jobs
       SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
       WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );

    await conn.commit();
    conn.release();
    conn = null;

    // Process all concurrently
    const results = await Promise.all(
      jobs.map((job) => processSingleJob(job, pool)),
    );
    return results.some(Boolean);
  } catch (err) {
    console.error("❌ PSA worker error:", err);
    if (conn) {
      try {
        await conn.rollback();
        conn.release();
      } catch {}
      conn = null;
    }
    return false;
  }
}

async function processSingleJob(job, pool) {
  try {
    const spaceKey = `PSA/${job.reference_number}.pdf`;
    const jsonKey = `PSA/${job.reference_number}.json`;
    const spaceFileUrl = `https://${process.env.SPACES_BUCKET}.sgp1.digitaloceanspaces.com/${spaceKey}`;

    // ─── Record PDF in psa_documents ──────────────────────────────────
    await pool.execute(
      `INSERT INTO psa_documents
        (reference_number, file_name, file_key, file_url, created_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         file_key = VALUES(file_key),
         file_url = VALUES(file_url)`,
      [
        job.reference_number,
        `${job.reference_number}.pdf`,
        spaceKey,
        spaceFileUrl,
      ],
    );

    // ─── Read JSON sidecar from Spaces ────────────────────────────────
    let orderData = null;

    try {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const obj = await getS3Client().send(
        new GetObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: jsonKey,
        }),
      );
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      orderData = Array.isArray(raw) ? raw[0] : raw;
      console.log(`📄 PSA job ${job.id} — JSON sidecar loaded from Spaces`);
    } catch (jsonErr) {
      if (jsonErr.$metadata?.httpStatusCode === 404) {
        console.warn(
          `⚠️  PSA job ${job.id} — no JSON sidecar, falling back to PSA API`,
        );
      } else {
        throw jsonErr;
      }
    }

    // ─── Fall back to PSA API if no sidecar ───────────────────────────
    if (!orderData) {
      const detailsResponse = await fetch(
        `${process.env.PSA_API_BASE_URL}/orders/${job.reference_number}`,
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
          },
        },
      );
      if (!detailsResponse.ok) {
        throw new Error(
          `PSA API returned ${detailsResponse.status} for ${job.reference_number}`,
        );
      }
      const detailsJson = await detailsResponse.json();
      orderData = detailsJson?.data ?? null;
      console.log(`📥 PSA job ${job.id} — order data fetched from PSA API`);
    }

    // ─── Insert into psa_order_data ───────────────────────────────────
    if (orderData) {
      await pool.execute(
        `INSERT INTO psa_order_data
          (reference_number, state, type, requester_name, requester_email, raw_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           state = VALUES(state),
           type = VALUES(type),
           requester_name = VALUES(requester_name),
           requester_email = VALUES(requester_email),
           raw_json = VALUES(raw_json),
           updated_at = NOW()`,
        [
          job.reference_number,
          orderData.state ?? null,
          orderData.type ?? null,
          orderData.requester?.name ?? null,
          orderData.requester?.email ?? null,
          JSON.stringify(orderData),
        ],
      );
      console.log(`✅ PSA job ${job.id} — order data saved`);
    } else {
      console.warn(
        `⚠️  PSA job ${job.id} — no order data, completing without it`,
      );
    }

    // ─── Mark job complete ────────────────────────────────────────────
    await pool.execute(
      `UPDATE psa_processing_jobs
       SET status = 'completed', processed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [job.id],
    );

    console.log(`✅ PSA job ${job.id} completed for ${job.reference_number}`);
    return true;
  } catch (error) {
    console.error(`❌ PSA job ${job.id} failed:`, error.message);
    try {
      const nextStatus = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      await pool.execute(
        `UPDATE psa_processing_jobs
         SET status = ?, error_message = ?, updated_at = NOW(),
             next_attempt_at = CASE WHEN ? = 'pending' THEN DATE_ADD(NOW(), INTERVAL 3 HOUR) ELSE NULL END
         WHERE id = ?`,
        [nextStatus, error.message, nextStatus, job.id],
      );
    } catch (updateError) {
      console.error(`❌ Failed to update job ${job.id} status:`, updateError);
    }
    return false;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function runWorkerLoop() {
  try {
    const hadWork = await processNextPsaJob();
    setTimeout(runWorkerLoop, hadWork ? 0 : 10_000);
  } catch (err) {
    console.error("❌ Unhandled PSA worker error:", err);
    setTimeout(runWorkerLoop, 10_000);
  }
}

pollSpacesForNewFiles().catch((err) => {
  console.error("❌ PSA poller startup error:", err);
});

setInterval(() => {
  pollSpacesForNewFiles().catch((err) => {
    console.error("❌ Unhandled PSA poller error:", err);
  });
}, POLL_INTERVAL_MS);

runWorkerLoop();

console.log("🚀 PSA worker + Spaces poller started");
