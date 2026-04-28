const {
  GetObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getPsaPgmcBucketClient, buildSpacesFileUrl } = require("./psaS3");

// ─── Constants ────────────────────────────────────────────────────────────────

const PSA_FOLDER = "PSA/";
const MAX_ATTEMPTS = 5;
const SYNC_CONCURRENCY = 10;

// Maps form_type_id → the requirements table and column to look up
const REQUIREMENTS_MAP = {
  5: { table: "upd_requirements", column: "form_id" },
};

// ─── Reference resolution ─────────────────────────────────────────────────────

/**
 * Resolves a PSA reference number from a form submission ID.
 * Checks psa_processing_jobs first, then falls back to the
 * form-type-specific requirements table.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string|number} formSubmissionId
 * @returns {Promise<string|null>}
 */
async function resolveReferenceNumber(pool, formSubmissionId) {
  // 1. Direct match in processing jobs
  const [jobRows] = await pool.execute(
    `SELECT reference_number FROM psa_processing_jobs
     WHERE form_submission_id = ? LIMIT 1`,
    [formSubmissionId],
  );
  if (jobRows.length > 0) return jobRows[0].reference_number;

  // 2. Look up form type and check the requirements table
  const [formRows] = await pool.execute(
    `SELECT form_type_id FROM form_submission WHERE id = ? LIMIT 1`,
    [formSubmissionId],
  );
  if (formRows.length === 0) return null;

  const mapping = REQUIREMENTS_MAP[formRows[0].form_type_id];
  if (!mapping) return null;

  const [reqRows] = await pool.execute(
    `SELECT value FROM ${mapping.table}
     WHERE ${mapping.column} = ?
       AND requirement_type IN ('crs4_reference', 'crs5_reference')
     LIMIT 1`,
    [formSubmissionId],
  );
  return reqRows.length > 0 ? reqRows[0].value : null;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Lists all PDFs in the PSA Spaces folder, then enqueues a processing job
 * for any that don't already have a job or a completed document record.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{ discovered: number, enqueued: number, skipped: number, errors: Array }>}
 */
async function discoverAndEnqueueJobs(pool) {
  const result = { discovered: 0, enqueued: 0, skipped: 0, errors: [] };
  const client = getPsaPgmcBucketClient();

  // Page through the entire PSA folder
  const files = [];
  let continuationToken;
  do {
    const data = await client.send(
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
  result.discovered = pdfs.length;
  if (pdfs.length === 0) return result;

  // Bulk-fetch known reference numbers to avoid per-file queries
  const [existingJobRows] = await pool.execute(
    `SELECT reference_number FROM psa_processing_jobs`,
  );
  const [existingDocRows] = await pool.execute(
    `SELECT reference_number FROM psa_documents`,
  );
  const jobSet = new Set(existingJobRows.map((r) => r.reference_number));
  const docSet = new Set(existingDocRows.map((r) => r.reference_number));

  for (const pdf of pdfs) {
    const referenceNumber = pdf.Key.replace(/^PSA\//, "").replace(/\.pdf$/, "");
    if (!referenceNumber) continue;

    if (jobSet.has(referenceNumber) || docSet.has(referenceNumber)) {
      result.skipped++;
      continue;
    }

    try {
      await pool.execute(
        `INSERT INTO psa_processing_jobs
           (reference_number, status, attempts, created_at, updated_at)
         VALUES (?, 'pending', 0, NOW(), NOW())`,
        [referenceNumber],
      );
      result.enqueued++;
    } catch (err) {
      result.errors.push({ referenceNumber, error: err.message });
    }
  }

  return result;
}

// ─── Job processing ───────────────────────────────────────────────────────────

/**
 * Claims up to SYNC_CONCURRENCY pending jobs, marks them as processing,
 * and runs them concurrently.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{ processed: number, failed: number, errors: Array }>}
 */
async function processAllPendingJobs(pool) {
  const summary = { processed: 0, failed: 0, errors: [] };

  while (true) {
    const jobs = await claimNextBatch(pool);
    if (jobs === null) break; // DB error — stop
    if (jobs.length === 0) break; // Nothing left — done

    const results = await Promise.allSettled(
      jobs.map((job) => processSingleJob(job, pool)),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        summary.processed++;
      } else {
        summary.failed++;
        if (result.status === "rejected") {
          summary.errors.push({ error: result.reason?.message });
        }
      }
    }
  }

  return summary;
}

/**
 * Atomically claims the next batch of pending/stalled jobs.
 * Returns the claimed jobs, an empty array if none remain, or null on error.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<Array|null>}
 */
async function claimNextBatch(pool) {
  let conn = null;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      `SELECT * FROM psa_processing_jobs
       WHERE
         (status = 'pending'     AND attempts < ?)
         OR
         (status = 'processing'  AND updated_at < NOW() - INTERVAL 5 MINUTE)
       ORDER BY id ASC
       LIMIT ${SYNC_CONCURRENCY}
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS],
    );

    if (rows.length === 0) {
      await conn.rollback();
      return [];
    }

    const ids = rows.map((j) => j.id);
    await conn.execute(
      `UPDATE psa_processing_jobs
       SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
       WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );

    await conn.commit();
    return rows;
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    console.error("❌ PSA claimNextBatch error:", err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

/**
 * Processes a single PSA job:
 *   1. Records the PDF in psa_documents
 *   2. Tries to load order data from a JSON sidecar in Spaces
 *   3. Falls back to the PSA API if no sidecar exists
 *   4. Saves order data to psa_order_data
 *   5. Marks the job complete (or failed/pending for retry)
 *
 * @param {{ id: number, reference_number: string, attempts: number }} job
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<boolean>}
 */
async function processSingleJob(job, pool) {
  try {
    const spaceKey = `PSA/${job.reference_number}.pdf`;
    const jsonKey = `PSA/${job.reference_number}.json`;
    const fileUrl = buildSpacesFileUrl(spaceKey);

    // 1. Record PDF
    await pool.execute(
      `INSERT INTO psa_documents
         (reference_number, file_name, file_key, file_url, created_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         file_key  = VALUES(file_key),
         file_url  = VALUES(file_url)`,
      [job.reference_number, `${job.reference_number}.pdf`, spaceKey, fileUrl],
    );

    // 2. Load order data — sidecar first, PSA API second
    const orderData = await fetchOrderData(job, jsonKey);

    // 3. Persist order data
    if (orderData) {
      await pool.execute(
        `INSERT INTO psa_order_data
           (reference_number, state, type, requester_name, requester_email, raw_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           state          = VALUES(state),
           type           = VALUES(type),
           requester_name  = VALUES(requester_name),
           requester_email = VALUES(requester_email),
           raw_json       = VALUES(raw_json),
           updated_at     = NOW()`,
        [
          job.reference_number,
          orderData.state ?? null,
          orderData.type ?? null,
          orderData.requester?.name ?? null,
          orderData.requester?.email ?? null,
          JSON.stringify(orderData),
        ],
      );
    } else {
      console.warn(
        `⚠️  PSA job ${job.id} — no order data found, completing anyway`,
      );
    }

    // 4. Mark complete
    await pool.execute(
      `UPDATE psa_processing_jobs
       SET status = 'completed', processed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [job.id],
    );

    console.log(`✅ PSA job ${job.id} completed (${job.reference_number})`);
    return true;
  } catch (error) {
    console.error(`❌ PSA job ${job.id} failed:`, error.message);
    await markJobFailed(job, pool, error.message);
    return false;
  }
}

/**
 * Tries to load order data from a JSON sidecar in Spaces.
 * Falls back to the PSA REST API on 404.
 *
 * @param {{ id: number, reference_number: string }} job
 * @param {string} jsonKey  Spaces object key for the sidecar
 * @returns {Promise<object|null>}
 */
async function fetchOrderData(job, jsonKey) {
  // Attempt sidecar
  try {
    const obj = await getPsaPgmcBucketClient().send(
      new GetObjectCommand({ Bucket: process.env.SPACES_BUCKET, Key: jsonKey }),
    );
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    console.log(`📄 PSA job ${job.id} — JSON sidecar loaded`);
    return Array.isArray(raw) ? raw[0] : raw;
  } catch (err) {
    if (err.$metadata?.httpStatusCode !== 404) throw err;
    console.warn(`⚠️  PSA job ${job.id} — no sidecar, calling PSA API`);
  }

  // Fall back to PSA API
  const response = await fetch(
    `${process.env.PSA_API_BASE_URL}/orders/${job.reference_number}`,
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `PSA API returned ${response.status} for ${job.reference_number}`,
    );
  }
  const json = await response.json();
  console.log(`📥 PSA job ${job.id} — order data fetched from PSA API`);
  return json?.data ?? null;
}

/**
 * Updates a job's status after a failure.
 * Requeues for retry if under MAX_ATTEMPTS; marks failed otherwise.
 */
async function markJobFailed(job, pool, errorMessage) {
  const nextStatus = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  try {
    await pool.execute(
      `UPDATE psa_processing_jobs
       SET status         = ?,
           error_message  = ?,
           updated_at     = NOW(),
           next_attempt_at = CASE
             WHEN ? = 'pending' THEN DATE_ADD(NOW(), INTERVAL 3 HOUR)
             ELSE NULL
           END
       WHERE id = ?`,
      [nextStatus, errorMessage, nextStatus, job.id],
    );
  } catch (err) {
    console.error(`❌ Failed to update job ${job.id} status:`, err.message);
  }
}

// ─── Queue status helper ──────────────────────────────────────────────────────

/**
 * Returns counts of jobs by status.
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{ pending: number, processing: number, completed: number, failed: number }>}
 */
async function getQueueStatus(pool) {
  const [rows] = await pool.execute(
    `SELECT status, COUNT(*) AS count FROM psa_processing_jobs GROUP BY status`,
  );
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = Number(row.count);
  }
  return counts;
}

module.exports = {
  PSA_FOLDER,
  MAX_ATTEMPTS,
  SYNC_CONCURRENCY,
  resolveReferenceNumber,
  discoverAndEnqueueJobs,
  processAllPendingJobs,
  claimNextBatch,
  processSingleJob,
  getQueueStatus,
};
