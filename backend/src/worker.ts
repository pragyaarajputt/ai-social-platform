import { prisma } from "./config/database.js";
import { env } from "./config/env.js";
import { runAnalyticsCollection } from "./jobs/analytics.js";
import { runConnectionHealthChecks } from "./jobs/connectionHealth.js";
import { reencryptOldTokens } from "./jobs/keyRotation.js";
import { runPublishCycle } from "./jobs/publishQueue.js";
import { runPreflightChecks } from "./services/preflight.service.js";
import { purgeExpiredConnectStates, refreshDueTokens } from "./services/tokenRefresh.service.js";

// Background jobs. Run with `npm run worker`, separately from the API. Safe to run several:
// - publishing (including scheduled posts once due): every few seconds; rows are claimed with
//   SKIP LOCKED, so no post is taken twice;
// - maintenance (token refresh, connection health checks, scheduled-post warnings, analytics
//   collection, re-encryption after a key rotation): hourly, guarded by a Postgres advisory lock.

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const MAINTENANCE_LOCK_ID = 7_310_001; // arbitrary constant: "token refresh"

/**
 * Runs maintenance only if no other worker is running it right now. The advisory lock is held by
 * this transaction and released automatically when it ends, even if the process dies.
 */
async function runMaintenance() {
  try {
    await prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${MAINTENANCE_LOCK_ID}) AS locked`;
        if (!row?.locked) {
          console.log("[worker] another worker holds the lock; skipping this run");
          return;
        }
        const summary = await refreshDueTokens();
        const purged = await purgeExpiredConnectStates();
        const health = await runConnectionHealthChecks();
        // After refreshing and checking, so warnings reflect each account's latest state.
        const preflight = await runPreflightChecks();
        // Last, and never allowed to break the rest of maintenance.
        const analytics = await runAnalyticsCollection().catch((err: unknown) => {
          console.error("[worker] analytics collection failed:", err);
          return null;
        });
        const rotation = await reencryptOldTokens();
        console.log(
          `[worker] token refresh: ${JSON.stringify(summary)}; expired connect states purged: ${purged}; ` +
            `health checks: ${JSON.stringify(health)}; scheduled-post warnings: ${JSON.stringify(preflight)}; ` +
            `analytics: ${JSON.stringify(analytics)}; re-encrypted: ${JSON.stringify(rotation)}`,
        );
      },
      { maxWait: 5_000, timeout: 10 * 60_000 },
    );
  } catch (err) {
    console.error("[worker] maintenance failed:", err);
  }
}

let publishing = false;
async function runPublishing() {
  if (publishing) return; // previous cycle still running
  publishing = true;
  try {
    const outcomes = await runPublishCycle();
    if (outcomes.length) console.log(`[worker] publish: ${outcomes.join(", ")}`);
  } catch (err) {
    console.error("[worker] publish cycle failed:", err);
  } finally {
    publishing = false;
  }
}

console.log(
  `[worker] started; publishing every ${env.publishPollIntervalMs / 1000}s, maintenance every ${MAINTENANCE_INTERVAL_MS / 60_000} minutes`,
);
void runMaintenance();
void runPublishing();
const timers = [
  setInterval(() => void runMaintenance(), MAINTENANCE_INTERVAL_MS),
  setInterval(() => void runPublishing(), env.publishPollIntervalMs),
];

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  timers.forEach(clearInterval);
  // Let an in-flight publish finish, so its progress is saved; its lock expires anyway if we're killed.
  for (let i = 0; publishing && i < 50; i++) await new Promise((r) => setTimeout(r, 200));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
