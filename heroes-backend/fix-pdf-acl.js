const {
  S3Client,
  ListObjectsV2Command,
  GetObjectAclCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  endpoint: "https://sgp1.digitaloceanspaces.com",
  region: "sgp1",
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
});

const BUCKET = process.env.SPACES_BUCKET;

async function isPublicRead(key) {
  const acl = await s3.send(
    new GetObjectAclCommand({ Bucket: BUCKET, Key: key }),
  );
  return acl.Grants?.some(
    (grant) =>
      grant.Grantee?.URI ===
        "http://acs.amazonaws.com/groups/global/AllUsers" &&
      grant.Permission === "READ",
  );
}

async function findPublicPdfs() {
  console.log("🔍 Scanning for public-read PDFs...\n");
  const publicKeys = [];
  let continuationToken = undefined;

  do {
    const listResponse = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
      }),
    );

    const pdfKeys = (listResponse.Contents || [])
      .filter((obj) => obj.Key.endsWith(".pdf"))
      .map((obj) => obj.Key);

    for (const key of pdfKeys) {
      try {
        const isPublic = await isPublicRead(key);
        if (isPublic) {
          console.log(`🔓 PUBLIC: ${key}`);
          publicKeys.push(key);
        } else {
          console.log(`🔒 private: ${key}`);
        }
      } catch (err) {
        console.error(`❌ Could not check: ${key} — ${err.message}`);
      }
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  console.log(`\n📊 Summary: ${publicKeys.length} public-read PDF(s) found`);
  publicKeys.forEach((k) => console.log(`  - ${k}`));

  return publicKeys;
}

async function makePrivate(keys) {
  console.log(`\n🔐 Making ${keys.length} file(s) private...\n`);
  let fixed = 0;
  let failed = 0;

  for (const key of keys) {
    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          CopySource: `${BUCKET}/${key}`,
          Key: key,
          ACL: "private",
          ContentType: "application/pdf",
          MetadataDirective: "REPLACE",
        }),
      );
      console.log(`✅ Fixed: ${key}`);
      fixed++;
    } catch (err) {
      console.error(`❌ Failed: ${key} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n🎉 Done! Fixed: ${fixed}, Failed: ${failed}`);
}

async function main() {
  const publicPdfs = await findPublicPdfs();

  if (publicPdfs.length === 0) {
    console.log("\n✅ No public PDFs found. Nothing to fix.");
    return;
  }

  // Comment this out if you just want to scan without fixing
  await makePrivate(publicPdfs);
}

main().catch(console.error);
