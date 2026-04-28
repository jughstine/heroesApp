/**
 * PSA Worker
 *
 * Responsibilities:
 *   1. Poll DigitalOcean Spaces every POLL_INTERVAL_MS for new PDFs
 *      and enqueue processing jobs for any that aren't already known.
 *   2. Continuously drain the job queue, processing jobs concurrently.
 *
 * All business logic lives in services/psaJobService.js.
 */

const { getPool } = require("../config/database");
const {
  discoverAndEnqueueJobs,
  claimNextBatch,
  processSingleJob,
} = require("../services/psaJobService");

const POLL_INTERVAL_MS = 10_000; // how often to scan Spaces for new PDFs
const IDLE_WAIT_MS = 10_000; // how long to wait when the job queue is empty

// ─── Poller ───────────────────────────────────────────────────────────────────

async function pollSpacesForNewFiles() {
  const pool = getPool();
  try {
    const result = await discoverAndEnqueueJobs(pool);
    console.log(
      `📂 PSA poller — found ${result.discovered} PDF(s), ` +
        `enqueued ${result.enqueued}, skipped ${result.skipped}`,
    );
    if (result.errors.length > 0) {
      console.warn("⚠️  PSA poller enqueue errors:", result.errors);
    }
  } catch (err) {
    console.error("❌ PSA poller error:", err);
  }
}

// ─── Worker loop ──────────────────────────────────────────────────────────────

async function runWorkerLoop() {
  const pool = getPool();

  try {
    const jobs = await claimNextBatch(pool);

    if (jobs === null) {
      // DB error — back off and retry
      setTimeout(runWorkerLoop, IDLE_WAIT_MS);
      return;
    }

    if (jobs.length === 0) {
      // Queue empty — wait before polling again
      setTimeout(runWorkerLoop, IDLE_WAIT_MS);
      return;
    }

    // Process the batch concurrently, then immediately loop for more
    await Promise.allSettled(jobs.map((job) => processSingleJob(job, pool)));
    setImmediate(runWorkerLoop);
  } catch (err) {
    console.error("❌ Unhandled PSA worker error:", err);
    setTimeout(runWorkerLoop, IDLE_WAIT_MS);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

// Initial poll, then repeat on a fixed interval
pollSpacesForNewFiles();
setInterval(pollSpacesForNewFiles, POLL_INTERVAL_MS);

// Kick off the worker loop
runWorkerLoop();

console.log("🚀 PSA worker + Spaces poller started");
