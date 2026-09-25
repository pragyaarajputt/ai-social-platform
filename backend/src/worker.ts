import { prisma } from "./config/database.js";
import { purgeExpiredConnectStates, refreshDueTokens } from "./services/tokenRefresh.service.js";

// Background jobs that don't need a queue yet. Run with `npm run worker`, separately from the API.
// Phase 5 moves publishing to BullMQ; this stays the home of periodic maintenance.

const INTERVAL_MS = 60 * 60_000; // hourly
const LOCK_ID = 7_310_001; // arbitrary constant: "token refresh"

/**
 * Runs the job only if no other worker is running it right now. The Postgres advisory lock is
 * held by this transaction and released automatically when it ends, even if the process dies.
 */
async function runExclusively() {
  await prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_ID}) AS locked`;
      if (!row?.locked) {
        console.log("[worker] another worker holds the lock; skipping this run");
        return;
      }
      const summary = await refreshDueTokens();
      const purged = await purgeExpiredConnectStates();
      console.log(`[worker] token refresh: ${JSON.stringify(summary)}; expired connect states purged: ${purged}`);
    },
    { maxWait: 5_000, timeout: 10 * 60_000 },
  );
}

async function tick() {
  try {
    await runExclusively();
  } catch (err) {
    console.error("[worker] run failed:", err);
  }
}

console.log(`[worker] started; running every ${INTERVAL_MS / 60_000} minutes`);
void tick();
const timer = setInterval(() => void tick(), INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  clearInterval(timer);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
