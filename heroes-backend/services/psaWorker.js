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

  const fileUrl = `https://${process.env.SPACES_BUCKET}.sgp1.digitaloceanspaces.com/${key}`;
  return { key, fileUrl };
}

// ─── Poller ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30 * 1000;
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

    for (const pdf of pdfs) {
      const referenceNumber = pdf.Key.replace(/^PSA\//, "").replace(
        /\.pdf$/,
        "",
      );

      if (!referenceNumber) continue;

      // Skip if a job already exists for this reference number
      const [existingJobs] = await pool.execute(
        `SELECT id FROM psa_processing_jobs WHERE reference_number = ? LIMIT 1`,
        [referenceNumber],
      );

      if (existingJobs.length > 0) continue;

      // Skip if already processed
      const [existingDocs] = await pool.execute(
        `SELECT id FROM psa_documents WHERE reference_number = ? LIMIT 1`,
        [referenceNumber],
      );

      if (existingDocs.length > 0) {
        console.log(
          `⏭️  PSA poller — ${referenceNumber} already in psa_documents, skipping`,
        );
        continue;
      }

      await pool.execute(
        `INSERT INTO psa_processing_jobs
          (reference_number, status, attempts, created_at, updated_at)
         VALUES (?, 'pending', 0, NOW(), NOW())`,
        [referenceNumber],
      );

      console.log(
        `✅ PSA poller — created job for reference number: ${referenceNumber}`,
      );
    }
  } catch (err) {
    console.error("❌ PSA poller error:", err);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;

async function processNextPsaJob() {
  const pool = getPool();
  let conn = null;
  let job = null;

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
       LIMIT 1
       FOR UPDATE`,
      [MAX_ATTEMPTS],
    );

    if (jobs.length === 0) {
      await conn.rollback();
      conn.release();
      conn = null;
      return false;
    }

    job = jobs[0];

    await conn.execute(
      `UPDATE psa_processing_jobs
       SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
       WHERE id = ?`,
      [job.id],
    );

    await conn.commit();
    conn.release();
    conn = null;

    const [existingDoc] = await pool.execute(
      `SELECT pd.file_key, pd.file_url 
       FROM psa_documents pd
       INNER JOIN psa_processing_jobs pj ON pj.form_submission_id = pd.form_submission_id
       WHERE pd.reference_number = ?
         AND pj.status = 'completed'
       LIMIT 1`,
      [job.reference_number],
    );

    if (existingDoc.length > 0) {
      console.log(
        `✅ PSA job ${job.id} — reference ${job.reference_number} already in Spaces, reusing`,
      );

      await pool.execute(
        `INSERT INTO psa_documents
          (form_submission_id, reference_number, file_name, file_key, file_url, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           file_key = VALUES(file_key),
           file_url = VALUES(file_url)`,
        [
          job.form_submission_id,
          job.reference_number,
          `${job.reference_number}.pdf`,
          existingDoc[0].file_key,
          existingDoc[0].file_url,
        ],
      );

      // Reuse existing order data instead of calling PSA API again
      const [existingOrder] = await pool.execute(
        `SELECT state, type, requester_name, requester_email, raw_json
         FROM psa_order_data WHERE reference_number = ? LIMIT 1`,
        [job.reference_number],
      );

      if (existingOrder.length > 0) {
        await pool.execute(
          `INSERT INTO psa_order_data
            (form_submission_id, reference_number, state, type, requester_name, requester_email, raw_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             state = VALUES(state),
             type = VALUES(type),
             requester_name = VALUES(requester_name),
             requester_email = VALUES(requester_email),
             raw_json = VALUES(raw_json),
             updated_at = NOW()`,
          [
            job.form_submission_id,
            job.reference_number,
            existingOrder[0].state,
            existingOrder[0].type,
            existingOrder[0].requester_name,
            existingOrder[0].requester_email,
            JSON.stringify(existingOrder[0].raw_json),
          ],
        );
        console.log(
          `✅ PSA job ${job.id} — reused existing order data, no API call made`,
        );
      } else {
        // No existing order data — still need to call PSA API once
        const detailsResponse = await fetch(
          `${process.env.PSA_API_BASE_URL}/orders/${job.reference_number}`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
            },
          },
        );

        if (detailsResponse.ok) {
          const detailsJson = await detailsResponse.json();
          await pool.execute(
            `INSERT INTO psa_order_data
              (form_submission_id, reference_number, state, type, requester_name, requester_email, raw_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               state = VALUES(state),
               type = VALUES(type),
               requester_name = VALUES(requester_name),
               requester_email = VALUES(requester_email),
               raw_json = VALUES(raw_json),
               updated_at = NOW()`,
            [
              job.form_submission_id,
              job.reference_number,
              detailsJson?.data?.state || null,
              detailsJson?.data?.type || null,
              detailsJson?.data?.requester?.name || null,
              detailsJson?.data?.requester?.email || null,
              JSON.stringify(detailsJson),
            ],
          );
        }
      }

      await pool.execute(
        `UPDATE psa_processing_jobs
         SET status = 'completed', processed_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [job.id],
      );

      console.log(`✅ PSA job ${job.id} completed — reused existing PDF`);
      return true;
    }

    // fetch order details from PSA API
    const detailsResponse = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${job.reference_number}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );

    if (!detailsResponse.ok) {
      throw new Error(
        `PSA details fetch failed with status ${detailsResponse.status}`,
      );
    }

    const detailsJson = await detailsResponse.json();
    const downloadResponse = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${job.reference_number}/download`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );

    if (!downloadResponse.ok) {
      throw new Error(
        `PSA download fetch failed with status ${downloadResponse.status}`,
      );
    }

    const downloadJson = await downloadResponse.json();
    const psaPresignedUrl = downloadJson?.url;

    if (!psaPresignedUrl) {
      throw new Error("PSA download URL is missing from response");
    }

    const pdfResponse = await fetch(psaPresignedUrl);

    if (!pdfResponse.ok) {
      throw new Error(
        `Failed to fetch PDF from PSA presigned URL: ${pdfResponse.status}`,
      );
    }

    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    const { key, fileUrl } = await uploadPsaPdf(
      job.reference_number,
      pdfBuffer,
    );

    await pool.execute(
      `INSERT INTO psa_order_data
        (form_submission_id, reference_number, state, type, requester_name, requester_email, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         state = VALUES(state),
         type = VALUES(type),
         requester_name = VALUES(requester_name),
         requester_email = VALUES(requester_email),
         raw_json = VALUES(raw_json),
         updated_at = NOW()`,
      [
        job.form_submission_id,
        job.reference_number,
        detailsJson?.data?.state || null,
        detailsJson?.data?.type || null,
        detailsJson?.data?.requester?.name || null,
        detailsJson?.data?.requester?.email || null,
        JSON.stringify(detailsJson),
      ],
    );

    await pool.execute(
      `INSERT INTO psa_documents
        (form_submission_id, reference_number, file_name, file_key, file_url, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         file_key = VALUES(file_key),
         file_url = VALUES(file_url)`,
      [
        job.form_submission_id,
        job.reference_number,
        `${job.reference_number}.pdf`,
        key,
        fileUrl,
      ],
    );

    await pool.execute(
      `UPDATE psa_processing_jobs
       SET status = 'completed', processed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [job.id],
    );

    console.log(`✅ PSA job ${job.id} completed — PDF stored at ${fileUrl}`);
    return true;
  } catch (error) {
    console.error("❌ PSA worker error:", error);

    if (job) {
      try {
        const nextStatus = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";

        await pool.execute(
          `UPDATE psa_processing_jobs
           SET status = ?, error_message = ?, updated_at = NOW(),
               next_attempt_at = CASE WHEN ? = 'pending' THEN DATE_ADD(NOW(), INTERVAL 3 HOUR) ELSE NULL END
           WHERE id = ?`,
          [nextStatus, error.message, nextStatus, job.id],
        );

        console.log(
          `⚠️ PSA job ${job.id} → ${nextStatus} (attempt ${job.attempts}/${MAX_ATTEMPTS})`,
        );
      } catch (updateError) {
        console.error("❌ Failed to update PSA job status:", updateError);
      }
    }

    return false;
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch {}
    }
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
