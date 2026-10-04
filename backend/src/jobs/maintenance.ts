import { prisma } from "../config/database.js";
import { runPreflightChecks } from "../services/preflight.service.js";
import { purgeExpiredConnectStates, refreshDueTokens } from "../services/tokenRefresh.service.js";
import { runAnalyticsCollection } from "./analytics.js";
import { runConnectionHealthChecks } from "./connectionHealth.js";
import { reencryptOldTokens } from "./keyRotation.js";

// Hourly maintenance: token refresh, connection health checks, scheduled-post warnings, analytics
// collection, re-encryption after a key rotation. Run by the worker (worker.ts) or, on hosts without
// an always-on worker, by the run-jobs endpoint (controllers/jobs.controller.ts).

export const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const MAINTENANCE_LOCK_ID = 7_310_001; // arbitrary constant: "token refresh"

/**
 * Runs maintenance only if nobody else is running it right now. The advisory lock is held by this
 * transaction and released automatically when it ends, even if the process dies. Returns false when
 * another run held the lock.
 */
export async function runMaintenance(): Promise<boolean> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${MAINTENANCE_LOCK_ID}) AS locked`;
        if (!row?.locked) {
          console.log("[maintenance] another run holds the lock; skipping");
          return false;
        }
        const summary = await refreshDueTokens();
        const purged = await purgeExpiredConnectStates();
        const health = await runConnectionHealthChecks();
        // After refreshing and checking, so warnings reflect each account's latest state.
        const preflight = await runPreflightChecks();
        // Last, and never allowed to break the rest of maintenance.
        const analytics = await runAnalyticsCollection().catch((err: unknown) => {
          console.error("[maintenance] analytics collection failed:", err);
          return null;
        });
        const rotation = await reencryptOldTokens();
        console.log(
          `[maintenance] token refresh: ${JSON.stringify(summary)}; expired connect states purged: ${purged}; ` +
            `health checks: ${JSON.stringify(health)}; scheduled-post warnings: ${JSON.stringify(preflight)}; ` +
            `analytics: ${JSON.stringify(analytics)}; re-encrypted: ${JSON.stringify(rotation)}`,
        );
        return true;
      },
      { maxWait: 5_000, timeout: 10 * 60_000 },
    );
  } catch (err) {
    console.error("[maintenance] failed:", err);
    return false;
  }
}

/**
 * Claims this hour's maintenance run when nothing keeps time between runs (each run-jobs call is a
 * fresh request). Atomic: of several calls at once, only one gets true, and only once per interval.
 */
export async function claimMaintenanceRun(now = new Date()): Promise<boolean> {
  const dueBefore = new Date(now.getTime() - MAINTENANCE_INTERVAL_MS);
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    INSERT INTO job_runs (name, last_run_at) VALUES ('maintenance', ${now})
    ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at
    WHERE job_runs.last_run_at <= ${dueBefore}
    RETURNING name`;
  return rows.length === 1;
}
