const express = require("express");
const router = express.Router();
const { getPool } = require("../config/database");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const psaUploadClient = new S3Client({
  endpoint: "https://sgp1.digitaloceanspaces.com",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.PSA_PGMC_KEY,
    secretAccessKey: process.env.PSA_PGMC_SECRET,
  },
  forcePathStyle: false,
});

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
    console.log("PSA download response:", JSON.stringify(json, null, 2));

    return res.json({
      success: true,
      data: {
        url: json.url,
      },
    });
  } catch (err) {
    console.error("PSA download error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error while downloading from PSA",
    });
  }
});

router.get("/psa_form/:id/psa-document", async (req, res) => {
  const { id } = req.params;
  const pool = getPool();

  try {
    // Step 1 — check our own Spaces first
    const [rows] = await pool.execute(
      `SELECT file_url, file_key, file_name FROM psa_documents WHERE form_submission_id = ? LIMIT 1`,
      [id],
    );

    if (rows.length > 0) {
      const { file_key, file_name } = rows[0];
      const command = new GetObjectCommand({
        Bucket: process.env.SPACES_BUCKET,
        Key: file_key,
      });
      const presignedUrl = await getSignedUrl(psaUploadClient, command, {
        expiresIn: 900,
      });
      return res.json({
        success: true,
        source: "spaces",
        data: { file_url: presignedUrl, file_name },
      });
    }

    // Step 2 — not in Spaces, resolve reference_number using multi-path lookup
    console.log(
      `⚠️ PSA document not in Spaces for form ${id}, falling back to PSA API`,
    );

    const REQUIREMENTS_MAP = {
      5: { table: "upd_requirements", column: "form_id" },
    };

    let reference_number = null;

    // Path 1: psa_processing_jobs
    const [jobRows] = await pool.execute(
      `SELECT reference_number FROM psa_processing_jobs WHERE form_submission_id = ? LIMIT 1`,
      [id],
    );
    if (jobRows.length > 0) {
      reference_number = jobRows[0].reference_number;
    }

    // Path 2: psa_order_data directly
    if (!reference_number) {
      const [orderRows] = await pool.execute(
        `SELECT reference_number FROM psa_order_data WHERE form_submission_id = ? LIMIT 1`,
        [id],
      );
      if (orderRows.length > 0) {
        reference_number = orderRows[0].reference_number;
      }
    }

    // Path 3: psa_documents by form_submission_id (already checked above for Spaces,
    // but we can still grab the reference_number from it)
    if (!reference_number) {
      const [docRows] = await pool.execute(
        `SELECT reference_number FROM psa_documents WHERE form_submission_id = ? LIMIT 1`,
        [id],
      );
      if (docRows.length > 0) {
        reference_number = docRows[0].reference_number;
      }
    }

    // Path 4: requirements table based on form_type_id
    if (!reference_number) {
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
            reference_number = reqRows[0].value;
          }
        }
      }
    }

    if (!reference_number) {
      return res.status(404).json({
        success: false,
        message: "No PSA job found for this form",
      });
    }

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

    // Download and save to Spaces in the background so next request is faster
    fetch(psaPresignedUrl)
      .then((r) => r.arrayBuffer())
      .then(async (buffer) => {
        const { PutObjectCommand } = require("@aws-sdk/client-s3");
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
          `INSERT INTO psa_documents
    (form_submission_id, reference_number, file_name, file_key, file_url, created_at)
   VALUES (?, ?, ?, ?, ?, NOW())
   ON DUPLICATE KEY UPDATE
     file_key = VALUES(file_key),
     file_url = VALUES(file_url)`,
          [id, reference_number, `${reference_number}.pdf`, key, fileUrl], // ← added id
        );

        console.log(`✅ Background save — PDF stored to Spaces for form ${id}`);
      })
      .catch((err) => console.error("❌ Background PDF save failed:", err));

    // Return PSA's presigned URL immediately while background save runs
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
    // Map form_type_id to its requirements table and reference column
    const REQUIREMENTS_MAP = {
      5: { table: "upd_requirements", column: "form_id" },
      // Add more form types here as needed:
      // 1: { table: "dl_requirements",  column: "form_id" },
      // 3: { table: "rst_requirements", column: "form_id" },
      // 4: { table: "top_requirements", column: "form_id" },
    };

    // Single query — tries all lookup paths at once
    // Path 1: psa_order_data.form_submission_id = id
    // Path 2: via psa_processing_jobs.form_submission_id = id
    // Path 3: via psa_documents.form_submission_id = id
    let [rows] = await pool.execute(
      `SELECT po.state, po.type, po.reference_number,
              po.requester_name, po.requester_email, po.raw_json, po.created_at
       FROM psa_order_data po
       WHERE po.form_submission_id = ?

       UNION

       SELECT po.state, po.type, po.reference_number,
              po.requester_name, po.requester_email, po.raw_json, po.created_at
       FROM psa_order_data po
       INNER JOIN psa_processing_jobs pj ON pj.reference_number = po.reference_number
       WHERE pj.form_submission_id = ?

       UNION

       SELECT po.state, po.type, po.reference_number,
              po.requester_name, po.requester_email, po.raw_json, po.created_at
       FROM psa_order_data po
       INNER JOIN psa_documents pd ON pd.reference_number = po.reference_number
       WHERE pd.form_submission_id = ?

       LIMIT 1`,
      [id, id, id],
    );

    // Path 4 — look up reference number from requirements table
    // based on the form's type, then find order data by reference number
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

    // Separate PDFs and JSONs
    const pdfs = files.filter((f) => f.Key.endsWith(".pdf"));
    const jsons = files.filter((f) => f.Key.endsWith(".json"));

    // Pair them by reference number (filename without extension)
    const paired = await Promise.all(
      pdfs.map(async (pdf) => {
        const refNumber = pdf.Key.replace(/^.*\//, "").replace(".pdf", "");

        // Find matching JSON
        const matchingJson = jsons.find(
          (j) => j.Key.replace(/^.*\//, "").replace(".json", "") === refNumber,
        );

        // Generate presigned URL for PDF
        const pdfUrl = await getSignedUrl(
          psaBucket,
          new GetObjectCommand({
            Bucket: process.env.PSA_BUCKET,
            Key: pdf.Key,
          }),
          { expiresIn: 900 },
        );

        // Generate presigned URL for JSON if exists
        let jsonData = null;
        if (matchingJson) {
          const jsonUrl = await getSignedUrl(
            psaBucket,
            new GetObjectCommand({
              Bucket: process.env.PSA_BUCKET,
              Key: matchingJson.Key,
            }),
            { expiresIn: 900 },
          );

          // Fetch and parse JSON content
          try {
            const jsonResponse = await fetch(jsonUrl);
            const jsonRaw = await jsonResponse.json();
            // unwrap array if needed
            jsonData = Array.isArray(jsonRaw) ? jsonRaw[0] : jsonRaw;
          } catch (e) {
            jsonData = null;
          }
        }

        return {
          reference_number: refNumber,
          pdf_key: pdf.Key,
          pdf_url: pdfUrl,
          pdf_size: pdf.Size,
          last_modified: pdf.LastModified,
          json_data: jsonData,
        };
      }),
    );

    return res.json({
      success: true,
      data: paired,
    });
  } catch (error) {
    console.error("PSA bucket list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to list PSA bucket files",
    });
  }
});

router.get("/psa/spaces/files", async (req, res) => {
  const pool = getPool();

  try {
    const [rows] = await pool.execute(
      `SELECT 
    pd.form_submission_id,
    pd.reference_number,
    pd.file_name,
    pd.file_key,
    pd.created_at,
    po.state,
    po.type,
    po.requester_name,
    po.requester_email,
    po.raw_json,
    fs.form_reference
   FROM psa_documents pd
   LEFT JOIN psa_order_data po 
     ON po.reference_number = pd.reference_number
   LEFT JOIN form_submission fs
     ON fs.id = pd.form_submission_id
   GROUP BY 
     pd.file_key,
     pd.form_submission_id,
     pd.reference_number,
     pd.file_name,
     pd.created_at,
     po.state,
     po.type,
     po.requester_name,
     po.requester_email,
     po.raw_json,
     fs.form_reference
   ORDER BY pd.created_at DESC`,
    );

    // Generate presigned URLs for each file
    const files = await Promise.all(
      rows.map(async (row) => {
        const command = new GetObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: row.file_key,
        });
        const presignedUrl = await getSignedUrl(psaPgmcBucket, command, {
          expiresIn: 900,
        });

        return {
          form_submission_id: row.form_submission_id,
          reference_number: row.reference_number,
          file_name: row.file_name,
          file_key: row.file_key,
          pdf_url: presignedUrl,
          created_at: row.created_at,
          state: row.state,
          type: row.type,
          requester_name: row.requester_name,
          requester_email: row.requester_email,
        };
      }),
    );

    return res.json({
      success: true,
      data: files,
    });
  } catch (error) {
    console.error("Spaces files list error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to list Spaces files",
    });
  }
});

router.delete("/psa/spaces/:reference_number/purge", async (req, res) => {
  const { reference_number } = req.params;
  const pool = getPool();

  console.log(`🗑️ Purge request for: ${reference_number}`);

  try {
    // Step 1 — get the file_key from DB
    const [rows] = await pool.execute(
      `SELECT file_key FROM psa_documents WHERE reference_number = ? LIMIT 1`,
      [reference_number],
    );

    console.log(`📦 DB rows found:`, rows);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Document not found in Spaces records",
      });
    }

    const { file_key } = rows[0];
    console.log(`🔑 file_key: ${file_key}`);

    // Step 2 — delete PDF from Spaces
    try {
      await psaPgmcBucket.send(
        new DeleteObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: file_key,
        }),
      );
      console.log(`✅ PDF deleted from Spaces`);
    } catch (s3Err) {
      console.error(`❌ S3 delete PDF failed:`, s3Err);
      return res.status(500).json({
        success: false,
        message: `Failed to delete PDF from Spaces: ${s3Err.message}`,
      });
    }

    // Step 3 — delete JSON sidecar (best effort)
    const jsonKey = file_key.replace(".pdf", ".json");
    try {
      await psaPgmcBucket.send(
        new DeleteObjectCommand({
          Bucket: process.env.SPACES_BUCKET,
          Key: jsonKey,
        }),
      );
      console.log(`✅ JSON sidecar deleted`);
    } catch (_) {
      console.log(`ℹ️ No JSON sidecar found (OK)`);
    }

    // Step 4 — mark purged in psa_order_data
    try {
      await pool.execute(
        `UPDATE psa_order_data
         SET state = 'purged', purged_at = NOW(), updated_at = NOW()
         WHERE reference_number = ?`,
        [reference_number],
      );
      console.log(`✅ psa_order_data updated`);
    } catch (dbErr) {
      console.error(`❌ psa_order_data update failed:`, dbErr);
      return res.status(500).json({
        success: false,
        message: `DB update failed: ${dbErr.message}`,
      });
    }

    // Step 5 — delete from psa_documents
    try {
      await pool.execute(
        `DELETE FROM psa_documents WHERE reference_number = ?`,
        [reference_number],
      );
      console.log(`✅ psa_documents row deleted`);
    } catch (dbErr) {
      console.error(`❌ psa_documents delete failed:`, dbErr);
      return res.status(500).json({
        success: false,
        message: `DB delete failed: ${dbErr.message}`,
      });
    }

    console.log(`✅ Purge complete for ${reference_number}`);
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

router.get("/psa_form/:id/psa-document/stream", async (req, res) => {
  const { id } = req.params;

  try {
    // Reuse your existing logic to get the file_url
    const docResponse = await fetch(
      `${process.env.SPACES_ENDPOINT}/psa_form/${id}/psa-document`,
    );
    const docJson = await docResponse.json();
    const fileUrl = docJson?.data?.file_url;

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
