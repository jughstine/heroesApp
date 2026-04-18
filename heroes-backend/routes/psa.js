const express = require("express");
const router = express.Router();
const { getPool } = require("../config/database");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const psaBucket = new S3Client({
  region: "ap-southeast-1",
  credentials: {
    accessKeyId: process.env.PSA_KEY,
    secretAccessKey: process.env.PSA_SECRET,
  },
});

const psaPgmcBucket = new S3Client({
  endpoint: "https://sgp1.digitaloceanspaces.com",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
  forcePathStyle: false,
});

router.get("/psa/orders/:reference_number", async (req, res) => {
  const { reference_number } = req.params;

  try {
    const response = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );

    switch (response.status) {
      case 401:
        return res
          .status(401)
          .json({ success: false, message: "PSA token is invalid" });
      case 403:
        return res
          .status(403)
          .json({ success: false, message: "PSA token lacks permission" });
      case 404:
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      case 429:
        return res
          .status(429)
          .json({ success: false, message: "Too many requests to PSA API" });
      case 503:
        return res
          .status(503)
          .json({ success: false, message: "PSA API is under maintenance" });
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: `PSA API returned an error: ${response.status}`,
      });
    }

    const json = await response.json();

    return res.json({
      success: true,
      data: {
        state: json.data.state,
        reference_number: json.data.reference_number,
        type: json.data.type,
        created_at: json.data.created_at,
        purged_at: json.data.purged_at,
        requester: {
          name: json.data.requester?.name,
          email: json.data.requester?.email,
        },
      },
    });
  } catch (err) {
    console.error("PSA order fetch error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error while contacting PSA API",
    });
  }
});

router.get("/psa/orders/:reference_number/download", async (req, res) => {
  const { reference_number } = req.params;

  try {
    const response = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}/download`,
      {
        method: "GET",
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
        message: `PSA API returned an error: ${response.status}`,
      });
    }

    const json = await response.json();
    return res.json({ success: true, data: { url: json.url } });
  } catch (err) {
    console.error("PSA download error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error while downloading from PSA",
    });
  }
});

async function resolveReferenceNumber(pool, id) {
  const REQUIREMENTS_MAP = {
    5: { table: "upd_requirements", column: "form_id" },
  };

  // Path 1: psa_processing_jobs
  const [jobRows] = await pool.execute(
    `SELECT reference_number FROM psa_processing_jobs WHERE form_submission_id = ? LIMIT 1`,
    [id],
  );
  if (jobRows.length > 0) return jobRows[0].reference_number;

  // Path 2: requirements table based on form_type_id
  const [formRows] = await pool.execute(
    `SELECT form_type_id FROM form_submission WHERE id = ? LIMIT 1`,
    [id],
  );
  if (formRows.length > 0) {
    const mapping = REQUIREMENTS_MAP[formRows[0].form_type_id];
    if (mapping) {
      const [reqRows] = await pool.execute(
        `SELECT value FROM ${mapping.table}
         WHERE ${mapping.column} = ?
           AND requirement_type IN ('crs4_reference', 'crs5_reference')
         LIMIT 1`,
        [id],
      );
      if (reqRows.length > 0) return reqRows[0].value;
    }
  }

  return null;
}

router.get("/psa_form/:id/psa-document", async (req, res) => {
  const { id } = req.params;
  const pool = getPool();

  try {
    // Step 1 — check our own Spaces first (lookup by reference_number via jobs/order_data)
    const reference_number = await resolveReferenceNumber(pool, id);

    if (reference_number) {
      const [docRows] = await pool.execute(
        `SELECT file_key, file_name FROM psa_documents WHERE reference_number = ? LIMIT 1`,
        [reference_number],
      );

      if (docRows.length > 0) {
        const { file_key, file_name } = docRows[0];
        const command = new GetObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: file_key,
        });
        const presignedUrl = await getSignedUrl(psaPgmcBucket, command, {
          expiresIn: 900,
        });
        return res.json({
          success: true,
          source: "spaces",
          data: { file_url: presignedUrl, file_name },
        });
      }
    }

    if (!reference_number) {
      return res.status(404).json({
        success: false,
        message: "No PSA job found for this form",
      });
    }

    // Step 2 — fall back to PSA API
    const downloadResponse = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}/download`,
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
      return res.status(downloadResponse.status).json({
        success: false,
        message:
          "PSA document not found in our storage and PSA API also failed",
      });
    }

    const downloadJson = await downloadResponse.json();
    const psaPresignedUrl = downloadJson?.url;

    if (!psaPresignedUrl) {
      return res.status(404).json({
        success: false,
        message: "PSA did not return a download URL",
      });
    }

    // Step 3 — background save to Spaces for next time
    fetch(psaPresignedUrl)
      .then((r) => r.arrayBuffer())
      .then(async (buffer) => {
        const pdfBuffer = Buffer.from(buffer);
        const key = `PSA/${reference_number}.pdf`;
        const endpoint = process.env.SPACES_ENDPOINT.replace("https://", "");
        const fileUrl = `https://${process.env.SPACES_BUCKET}.${endpoint}/${key}`;

        await psaPgmcBucket.send(
          new PutObjectCommand({
            Bucket: process.env.SPACES_BUCKET,
            Key: key,
            Body: pdfBuffer,
            ContentType: "application/pdf",
          }),
        );

        await pool.execute(
          `INSERT INTO psa_documents (reference_number, file_name, file_key, file_url, created_at)
           VALUES (?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             file_key = VALUES(file_key),
             file_url = VALUES(file_url)`,
          [reference_number, `${reference_number}.pdf`, key, fileUrl],
        );
      })
      .catch((err) => console.error("❌ Background PDF save failed:", err));

    return res.json({
      success: true,
      source: "psa_api",
      data: {
        file_url: psaPresignedUrl,
        file_name: `${reference_number}.pdf`,
      },
    });
  } catch (error) {
    console.error("PSA document fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch PSA document",
    });
  }
});

router.get("/psa_form/:id/psa-order", async (req, res) => {
  const { id } = req.params;
  const pool = getPool();

  try {
    const REQUIREMENTS_MAP = {
      5: { table: "upd_requirements", column: "form_id" },
    };

    // Try all lookup paths — no longer using psa_documents.form_submission_id
    let [rows] = await pool.execute(
      `SELECT po.state, po.type, po.reference_number,
              po.requester_name, po.requester_email, po.raw_json, po.created_at
       FROM psa_order_data po
       WHERE po.reference_number = ?

       UNION

       SELECT po.state, po.type, po.reference_number,
              po.requester_name, po.requester_email, po.raw_json, po.created_at
       FROM psa_order_data po
       INNER JOIN psa_processing_jobs pj ON pj.reference_number = po.reference_number
       WHERE pj.form_submission_id = ?

       LIMIT 1`,
      [id, id],
    );

    // Path 3 — requirements table fallback
    if (rows.length === 0) {
      const [formRows] = await pool.execute(
        `SELECT form_type_id FROM form_submission WHERE id = ? LIMIT 1`,
        [id],
      );

      if (formRows.length > 0) {
        const mapping = REQUIREMENTS_MAP[formRows[0].form_type_id];
        if (mapping) {
          const [reqRows] = await pool.execute(
            `SELECT value FROM ${mapping.table}
             WHERE ${mapping.column} = ?
               AND requirement_type IN ('crs4_reference', 'crs5_reference')
             LIMIT 1`,
            [id],
          );

          if (reqRows.length > 0) {
            [rows] = await pool.execute(
              `SELECT state, type, reference_number,
                      requester_name, requester_email, raw_json, created_at
               FROM psa_order_data
               WHERE reference_number = ?
               LIMIT 1`,
              [reqRows[0].value],
            );
          }
        }
      }
    }

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "PSA order data not found",
      });
    }

    const row = rows[0];
    const raw = row.raw_json;

    return res.json({
      success: true,
      data: {
        state: row.state,
        type: row.type,
        reference_number: row.reference_number,
        created_at: raw?.data?.created_at,
        purged_at: raw?.data?.purged_at,
        requester: {
          name: row.requester_name,
          email: row.requester_email,
        },
      },
    });
  } catch (error) {
    console.error("PSA order data fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch PSA order data",
    });
  }
});

router.get("/psa/bucket/files", async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.PSA_BUCKET,
    });
    const data = await psaBucket.send(command);
    const files = data.Contents || [];

    const pdfs = files.filter((f) => f.Key.endsWith(".pdf"));
    const jsons = files.filter((f) => f.Key.endsWith(".json"));

    const jsonKeyMap = new Map(
      jsons.map((j) => [
        j.Key.replace(/^.*\//, "").replace(".json", ""),
        j.Key,
      ]),
    );

    const jsonContentMap = new Map();
    await Promise.all(
      [...jsonKeyMap.entries()].map(async ([refNumber, key]) => {
        try {
          const obj = await psaBucket.send(
            new GetObjectCommand({ Bucket: process.env.PSA_BUCKET, Key: key }),
          );
          const chunks = [];
          for await (const chunk of obj.Body) chunks.push(chunk);
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          jsonContentMap.set(refNumber, Array.isArray(raw) ? raw[0] : raw);
        } catch (e) {
          console.warn(`Failed to fetch JSON for ${refNumber}:`, e.message);
          jsonContentMap.set(refNumber, null);
        }
      }),
    );

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

router.get("/psa/spaces/files", async (req, res) => {
  const pool = getPool();

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = (page - 1) * limit;

  try {
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(DISTINCT pd.reference_number) as total FROM psa_documents pd`,
    );

    const [rows] = await pool.query(
      `SELECT
         pd.reference_number,
         pd.file_name,
         pd.file_key,
         pd.created_at,
         po.state,
         po.type,
         po.requester_name,
         po.requester_email,
         fs.form_reference
       FROM psa_documents pd
       LEFT JOIN psa_order_data po ON po.reference_number = pd.reference_number
       LEFT JOIN form_submission fs ON fs.id = pd.reference_number
       ORDER BY pd.created_at DESC
       `,
    );

    return res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    console.error("Spaces files list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to list Spaces files",
      detail: error.message,
    });
  }
});

router.get("/psa/spaces/:reference_number/url", async (req, res) => {
  const pool = getPool();
  const { reference_number } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT file_key FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );
    if (rows.length === 0) return res.status(404).json({ success: false });

    const command = new GetObjectCommand({
      Bucket: process.env.SPACES_BUCKET,
      Key: rows[0].file_key,
    });
    const url = await getSignedUrl(psaPgmcBucket, command, { expiresIn: 900 });
    return res.json({ success: true, data: { url } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

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

    // Delete PDF from Spaces
    try {
      await psaPgmcBucket.send(
        new DeleteObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: file_key,
        }),
      );
    } catch (s3Err) {
      console.error(`❌ S3 delete PDF failed:`, s3Err);
      return res.status(500).json({
        success: false,
        message: `Failed to delete PDF from Spaces: ${s3Err.message}`,
      });
    }

    // Delete JSON sidecar (best effort)
    try {
      await psaPgmcBucket.send(
        new DeleteObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: file_key.replace(".pdf", ".json"),
        }),
      );
    } catch (_) {}

    // Mark purged in psa_order_data
    await pool.execute(
      `UPDATE psa_order_data
       SET state = 'purged', purged_at = NOW(), updated_at = NOW()
       WHERE reference_number = ?`,
      [reference_number],
    );

    // Remove from psa_documents
    await pool.execute(`DELETE FROM psa_documents WHERE reference_number = ?`, [
      reference_number,
    ]);

    return res.json({
      success: true,
      message: `Document ${reference_number} has been purged from Spaces`,
    });
  } catch (err) {
    console.error("❌ Spaces purge error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to purge document from Spaces",
    });
  }
});

// Stream PDF directly without an internal HTTP self-call
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

    const [docRows] = await pool.execute(
      `SELECT file_key FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );

    let fileUrl;

    if (docRows.length > 0) {
      // Serve from Spaces
      const command = new GetObjectCommand({
        Bucket: process.env.SPACES_BUCKET,
        Key: docRows[0].file_key,
      });
      fileUrl = await getSignedUrl(psaPgmcBucket, command, { expiresIn: 900 });
    } else {
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
          message: "Failed to get download URL from PSA",
        });
      }
      const json = await downloadResponse.json();
      fileUrl = json?.url;
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
    res.setHeader("Content-Disposition", `inline; filename="${id}.pdf"`);
    pdfResponse.body.pipe(res);
  } catch (err) {
    console.error("PDF stream error:", err);
    res.status(500).json({ success: false, message: "Failed to stream PDF" });
  }
});

module.exports = router;
