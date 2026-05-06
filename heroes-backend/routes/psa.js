const express = require("express");
const router = express.Router();
const { getPool } = require("../config/database");
const {
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  getPsaBucketClient,
  getPsaPgmcBucketClient,
  buildSpacesFileUrl,
} = require("../services/psaS3");
const {
  resolveReferenceNumber,
  discoverAndEnqueueJobs,
  getQueueStatus,
} = require("../services/psaJobService");

// ─── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Scans Spaces for new PDFs and enqueues jobs. The background worker
 * handles actual processing automatically.
 */
router.post("/psa/sync", async (req, res) => {
  const pool = getPool();
  try {
    const [discovery, queueCounts] = await Promise.all([
      discoverAndEnqueueJobs(pool),
      getQueueStatus(pool),
    ]);

    return res.json({
      success: true,
      summary: {
        filesFoundInSpaces: discovery.discovered,
        newJobsEnqueued: discovery.enqueued,
        filesAlreadyKnown: discovery.skipped,
        discoveryErrors: discovery.errors,
        jobQueue: queueCounts,
      },
    });
  } catch (err) {
    console.error("❌ PSA sync error:", err);
    return res
      .status(500)
      .json({ success: false, message: err.message || "Sync failed" });
  }
});

/**
 * Returns current job queue counts by status.
 */
router.get("/psa/sync/status", async (req, res) => {
  const pool = getPool();
  try {
    const counts = await getQueueStatus(pool);
    return res.json({ success: true, data: counts });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PSA API proxy ────────────────────────────────────────────────────────────

const PSA_HTTP_ERRORS = {
  401: "PSA token is invalid",
  403: "PSA token lacks permission",
  404: "Order not found",
  429: "Too many requests to PSA API",
  503: "PSA API is under maintenance",
};

/**
 * Proxies a single order lookup to the PSA API.
 */
router.get("/psa/orders/:reference_number", async (req, res) => {
  const { reference_number } = req.params;
  try {
    const response = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}`,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );

    const errorMsg = PSA_HTTP_ERRORS[response.status];
    if (errorMsg)
      return res
        .status(response.status)
        .json({ success: false, message: errorMsg });
    if (!response.ok) {
      return res
        .status(502)
        .json({ success: false, message: `PSA API error: ${response.status}` });
    }

    return res.json({ success: true, data: await response.json() });
  } catch (err) {
    console.error("PSA order fetch error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error contacting PSA API",
    });
  }
});

/**
 * GET /psa/orders/:reference_number/download
 * Returns a PSA-issued download URL for a given order.
 */
router.get("/psa/orders/:reference_number/download", async (req, res) => {
  const { reference_number } = req.params;
  try {
    const response = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}/download`,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );
    if (!response.ok) {
      return res
        .status(response.status)
        .json({ success: false, message: `PSA API error: ${response.status}` });
    }
    const json = await response.json();
    return res.json({ success: true, data: { url: json.url } });
  } catch (err) {
    console.error("PSA download error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error downloading from PSA",
    });
  }
});

// GET /psa/order-data/:reference_number
router.get("/psa/order-data/:reference_number", async (req, res) => {
  const { reference_number } = req.params;
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      `SELECT state, type, reference_number,
              requester_name, requester_email, raw_json, created_at
       FROM psa_order_data
       WHERE reference_number = ?
       LIMIT 1`,
      [reference_number],
    );
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "PSA order data not found" });
    }
    const row = rows[0];
    const raw =
      typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;
    return res.json({
      success: true,
      data: {
        state: row.state,
        type: row.type,
        reference_number: row.reference_number,
        created_at: raw?.created_at,
        purged_at: raw?.purged_at,
        requester: {
          name: row.requester_name,
          email: row.requester_email,
          primary_last_name: raw?.requester?.primary_last_name,
          primary_first_name: raw?.requester?.primary_first_name,
          primary_middle_name: raw?.requester?.primary_middle_name,
        },
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch PSA order data" });
  }
});

// ─── Form-linked document helpers ────────────────────────────────────────────

/**
 * Returns a presigned URL for the PSA document linked to a form submission.
 * Sources in order: Spaces → PSA API (with background save to Spaces).
 */
router.get("/psa_form/:id/psa-document", async (req, res) => {
  const { id } = req.params;
  const pool = getPool();
  try {
    const reference_number = await resolveReferenceNumber(pool, id);
    if (!reference_number) {
      return res
        .status(404)
        .json({ success: false, message: "No PSA job found for this form" });
    }

    const [docRows] = await pool.execute(
      `SELECT file_key, file_name FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );

    if (docRows.length > 0) {
      const { file_key, file_name } = docRows[0];
      const publicUrl = buildSpacesFileUrl(file_key);

      return res.json({
        success: true,
        source: "spaces",
        data: { file_url: publicUrl, file_name },
      });
    }

    // Fall back to PSA API
    const downloadResponse = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}/download`,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );
    if (!downloadResponse.ok) {
      return res.status(downloadResponse.status).json({
        success: false,
        message: "Document not in Spaces and PSA API also failed",
      });
    }

    const psaPresignedUrl = (await downloadResponse.json())?.url;
    if (!psaPresignedUrl) {
      return res
        .status(404)
        .json({ success: false, message: "PSA did not return a download URL" });
    }

    // Save to Spaces in the background so next request is served locally
    saveToSpacesInBackground(psaPresignedUrl, reference_number, pool);

    return res.json({
      success: true,
      source: "psa_api",
      data: { file_url: psaPresignedUrl, file_name: `${reference_number}.pdf` },
    });
  } catch (error) {
    console.error("PSA document fetch error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch PSA document" });
  }
});

/**
 * Streams the PDF directly to the client.
 */
router.get("/psa_form/:id/psa-document/stream", async (req, res) => {
  const { id } = req.params;
  const pool = getPool();
  try {
    const reference_number = await resolveReferenceNumber(pool, id);
    if (!reference_number) {
      return res
        .status(404)
        .json({ success: false, message: "No PSA job found for this form" });
    }

    let fileUrl;
    const [docRows] = await pool.execute(
      `SELECT file_key FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );

    if (docRows.length > 0) {
      fileUrl = await getSignedUrl(
        getPsaPgmcBucketClient(),
        new GetObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: docRows[0].file_key,
        }),
        { expiresIn: 900 },
      );
    } else {
      const response = await fetch(
        `${process.env.PSA_API_BASE_URL}/orders/${reference_number}/download`,
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
          },
        },
      );
      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          message: "Failed to get download URL from PSA",
        });
      }
      fileUrl = (await response.json())?.url;
    }

    if (!fileUrl) {
      return res.status(404).json({ success: false, message: "No PDF found" });
    }

    const pdfResponse = await fetch(fileUrl);
    if (!pdfResponse.ok) {
      return res
        .status(502)
        .json({ success: false, message: "Failed to fetch PDF" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${reference_number}.pdf"`,
    );

    const { Readable } = require("stream");
    const nodeStream = Readable.fromWeb(pdfResponse.body);
    nodeStream.pipe(res);
  } catch (err) {
    console.error("PDF stream error:", err);
    res.status(500).json({ success: false, message: "Failed to stream PDF" });
  }
});

/**
 * Returns structured order data for a form submission.
 */
router.get("/psa_form/:id/psa-order", async (req, res) => {
  const { id } = req.params;
  const pool = getPool();
  try {
    const reference_number = await resolveReferenceNumber(pool, id);

    const query = reference_number
      ? `SELECT state, type, reference_number, requester_name, requester_email, raw_json, created_at
         FROM psa_order_data
         WHERE reference_number = ?
         LIMIT 1`
      : // If no reference resolved, try matching directly against the form submission ID
        `SELECT po.state, po.type, po.reference_number,
                po.requester_name, po.requester_email, po.raw_json, po.created_at
         FROM psa_order_data po
         INNER JOIN psa_processing_jobs pj ON pj.reference_number = po.reference_number
         WHERE pj.form_submission_id = ?
         LIMIT 1`;

    const [rows] = await pool.execute(query, [reference_number ?? id]);

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "PSA order data not found" });
    }

    const row = rows[0];
    const raw =
      typeof row.raw_json === "string"
        ? JSON.parse(row.raw_json)
        : row.raw_json;

    return res.json({
      success: true,
      data: {
        state: row.state,
        type: row.type,
        reference_number: row.reference_number,
        created_at: raw?.created_at,
        purged_at: raw?.purged_at,
        requester: {
          name: row.requester_name,
          email: row.requester_email,
          primary_last_name: raw?.requester?.primary_last_name,
          primary_first_name: raw?.requester?.primary_first_name,
          primary_middle_name: raw?.requester?.primary_middle_name,
        },
      },
    });
  } catch (error) {
    console.error("PSA order data fetch error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch PSA order data" });
  }
});

// ─── Bucket / Spaces file listings ───────────────────────────────────────────

/**
 * GET /psa/bucket/files
 * Lists files from the legacy PSA AWS S3 bucket, pairing PDFs with their
 * JSON sidecars.
 */
router.get("/psa/bucket/files", async (req, res) => {
  try {
    const psaBucket = getPsaBucketClient();
    const data = await psaBucket.send(
      new ListObjectsV2Command({ Bucket: process.env.PSA_BUCKET }),
    );
    const files = data.Contents || [];
    const pdfs = files.filter((f) => f.Key.endsWith(".pdf"));
    const jsons = files.filter((f) => f.Key.endsWith(".json"));

    const jsonKeyMap = new Map(
      jsons.map((j) => [
        j.Key.replace(/^.*\//, "").replace(".json", ""),
        j.Key,
      ]),
    );

    // Fetch all JSON sidecars concurrently
    const jsonContentMap = new Map(
      await Promise.all(
        [...jsonKeyMap.entries()].map(async ([refNumber, key]) => {
          try {
            const obj = await psaBucket.send(
              new GetObjectCommand({
                Bucket: process.env.PSA_BUCKET,
                Key: key,
              }),
            );
            const chunks = [];
            for await (const chunk of obj.Body) chunks.push(chunk);
            const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            return [refNumber, Array.isArray(raw) ? raw[0] : raw];
          } catch (e) {
            console.warn(`Failed to fetch JSON for ${refNumber}:`, e.message);
            return [refNumber, null];
          }
        }),
      ),
    );

    // Build paired results with presigned URLs
    const paired = await Promise.all(
      pdfs.map(async (pdf) => {
        const refNumber = pdf.Key.replace(/^.*\//, "").replace(".pdf", "");
        const pdfUrl = await getSignedUrl(
          psaBucket,
          new GetObjectCommand({
            Bucket: process.env.PSA_BUCKET,
            Key: pdf.Key,
          }),
          { expiresIn: 900 },
        );
        return {
          reference_number: refNumber,
          pdf_key: pdf.Key,
          pdf_url: pdfUrl,
          pdf_size: pdf.Size,
          last_modified: pdf.LastModified,
          json_data: jsonContentMap.get(refNumber) ?? null,
        };
      }),
    );

    return res.json({ success: true, data: paired });
  } catch (error) {
    console.error("PSA bucket list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to list PSA bucket files",
      detail: error.message,
    });
  }
});

/**
 * GET /psa/spaces/files
 * Paginated listing of documents in our Spaces bucket, with optional
 * search and type filter. Joined with order data for display.
 */
router.get("/psa/spaces/files", async (req, res) => {
  const pool = getPool();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const search = req.query.search?.trim() || "";
  const type = req.query.type?.trim() || "";
  try {
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push(
        `(pd.reference_number LIKE ? OR po.requester_name LIKE ? OR po.requester_email LIKE ?)`,
      );
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (type && type !== "all") {
      conditions.push(`po.type = ?`);
      params.push(type);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total
       FROM psa_documents pd
       LEFT JOIN psa_order_data po ON po.reference_number = pd.reference_number
       LEFT JOIN form_submission fs ON fs.id = pd.reference_number
       ${where}`,
      params,
    );

    const [rows] = await pool.query(
      `SELECT
         pd.reference_number, pd.file_name, pd.file_key, pd.created_at,
         po.state, po.type, po.requester_name, po.requester_email,
         fs.form_reference
       FROM psa_documents pd
       LEFT JOIN psa_order_data po ON po.reference_number = pd.reference_number
       LEFT JOIN form_submission fs ON fs.id = pd.reference_number
       ${where}
       ORDER BY pd.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const totalPages = Math.ceil(Number(total) / limit);
    return res.json({
      success: true,
      data: rows,
      pagination: {
        total: Number(total),
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Spaces files list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to list Spaces files",
      detail: error.message,
    });
  }
});

/**
 * Returns a fresh presigned URL for a document stored in Spaces.
 */
router.get("/psa/spaces/:reference_number/url", async (req, res) => {
  const pool = getPool();
  const { reference_number } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT file_key FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );
    if (rows.length === 0) return res.status(404).json({ success: false });

    const url = await getSignedUrl(
      getPsaPgmcBucketClient(),
      new GetObjectCommand({
        Bucket: process.env.SPACES_BUCKET,
        Key: rows[0].file_key,
      }),
      { expiresIn: 900 },
    );
    return res.json({ success: true, data: { url } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /psa/spaces/:reference_number/purge
 * Deletes the PDF (and JSON sidecar) from Spaces and removes the document
 * record from the database.
 */
router.delete("/psa/spaces/:reference_number/purge", async (req, res) => {
  const { reference_number } = req.params;
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      `SELECT file_key FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Document not found in Spaces records",
      });
    }

    const { file_key } = rows[0];
    const client = getPsaPgmcBucketClient();

    // Delete PDF
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: file_key,
        }),
      );
    } catch (s3Err) {
      console.error("❌ S3 delete PDF failed:", s3Err);
      return res.status(500).json({
        success: false,
        message: `Failed to delete PDF from Spaces: ${s3Err.message}`,
      });
    }

    // Delete JSON sidecar (best effort — don't fail the whole purge if missing)
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: file_key.replace(".pdf", ".json"),
        }),
      );
    } catch (_) {}

    // Update DB
    await pool.execute(
      `UPDATE psa_order_data SET state = 'purged', purged_at = NOW(), updated_at = NOW()
       WHERE reference_number = ?`,
      [reference_number],
    );
    await pool.execute(`DELETE FROM psa_documents WHERE reference_number = ?`, [
      reference_number,
    ]);

    return res.json({
      success: true,
      message: `Document ${reference_number} purged from Spaces`,
    });
  } catch (err) {
    console.error("❌ Spaces purge error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to purge document from Spaces",
    });
  }
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetches a PDF from a PSA presigned URL and saves it to Spaces + DB
 * in the background (fire-and-forget). Errors are logged, never thrown.
 */
function saveToSpacesInBackground(psaPresignedUrl, referenceNumber, pool) {
  fetch(psaPresignedUrl)
    .then((r) => r.arrayBuffer())
    .then(async (buffer) => {
      const key = `PSA/${referenceNumber}.pdf`;
      const fileUrl = buildSpacesFileUrl(key);

      await getPsaPgmcBucketClient().send(
        new PutObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: key,
          Body: Buffer.from(buffer),
          ContentType: "application/pdf",
        }),
      );

      await pool.execute(
        `INSERT INTO psa_documents (reference_number, file_name, file_key, file_url, created_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE file_key = VALUES(file_key), file_url = VALUES(file_url)`,
        [referenceNumber, `${referenceNumber}.pdf`, key, fileUrl],
      );
    })
    .catch((err) => console.error("❌ Background PDF save failed:", err));
}

module.exports = router;
