import { prisma } from "./config/database.js";
import { env } from "./config/env.js";
import { MAINTENANCE_INTERVAL_MS, runMaintenance } from "./jobs/maintenance.js";
import { runPublishCycle } from "./jobs/publishQueue.js";

// Background jobs. Run with `npm run worker`, separately from the API. Safe to run several:
// - publishing (including scheduled posts once due): every few seconds; rows are claimed with
//   SKIP LOCKED, so no post is taken twice;
// - maintenance (jobs/maintenance.ts): hourly, guarded by a Postgres advisory lock.
// Hosts without an always-on process (e.g. Vercel) call POST /api/v1/internal/run-jobs instead.

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
