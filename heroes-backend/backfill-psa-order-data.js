// backfill-order-data.js
require("dotenv").config();
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { initializeDatabase, getPool } = require("./config/database");

const s3 = new S3Client({
  endpoint: "https://sgp1.digitaloceanspaces.com",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
  forcePathStyle: false,
});

const BATCH_SIZE = 10;
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJsonSidecar(referenceNumber) {
  try {
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.SPACES_BUCKET,
        Key: `PSA/${referenceNumber}.json`,
      }),
    );
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return Array.isArray(raw) ? raw[0] : raw;
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function fetchFromPsaApi(referenceNumber) {
  const res = await fetch(
    `${process.env.PSA_API_BASE_URL}/orders/${referenceNumber}`,
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PSA API returned ${res.status}`);
  const json = await res.json();
  return json?.data ?? null;
}

async function backfill() {
  await initializeDatabase();
  const pool = getPool();

  // Only target rows with no matching psa_order_data
  const [rows] = await pool.execute(
    `SELECT pd.reference_number
     FROM psa_documents pd
     LEFT JOIN psa_order_data po ON po.reference_number = pd.reference_number
     WHERE po.reference_number IS NULL
     ORDER BY pd.created_at DESC`,
  );

  console.log(`📦 Records to backfill: ${rows.length}`);

  let fromSpaces = 0,
    fromApi = 0,
    skipped = 0,
    failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ({ reference_number }) => {
        try {
          // Try Spaces sidecar first
          let orderData = await readJsonSidecar(reference_number);
          let source = "spaces";

          // Fall back to PSA API
          if (!orderData) {
            orderData = await fetchFromPsaApi(reference_number);
            source = "api";
          }

          if (!orderData) {
            console.warn(`⚠️  No data found for ${reference_number}, skipping`);
            skipped++;
            return;
          }

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
              reference_number,
              orderData.state ?? null,
              orderData.type ?? null,
              orderData.requester?.name ?? null,
              orderData.requester?.email ?? null,
              JSON.stringify(orderData),
            ],
          );

          if (source === "spaces") fromSpaces++;
          else fromApi++;
        } catch (err) {
          console.error(`❌ Failed ${reference_number}:`, err.message);
          failed++;
        }
      }),
    );

    console.log(
      `✅ ${i + batch.length}/${rows.length} — spaces: ${fromSpaces}, api: ${fromApi}, skipped: ${skipped}, failed: ${failed}`,
    );
    await sleep(DELAY_MS);
  }

  console.log(
    `\n🎉 Done. Spaces: ${fromSpaces} | API: ${fromApi} | Skipped: ${skipped} | Failed: ${failed}`,
  );
  process.exit(0);
}

backfill().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
