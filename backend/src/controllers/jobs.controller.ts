import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { claimMaintenanceRun, runMaintenance } from "../jobs/maintenance.js";
import { runPublishCycle } from "../jobs/publishQueue.js";

// One round of the worker's jobs, for hosts without an always-on process (e.g. Vercel): an outside
// scheduler calls this every minute. Publishing runs on every call; maintenance at most hourly.
// Off (404) unless CRON_SECRET is set; the scheduler sends it as "Authorization: Bearer <secret>".

const digest = (s: string) => createHash("sha256").update(s).digest();

function authorized(header: string | undefined): boolean {
  if (!env.cronSecret || !header?.startsWith("Bearer ")) return false;
  // Hashing first gives equal-length buffers, so the comparison takes the same time for any input.
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(env.cronSecret));
}

export const runJobs: RequestHandler = async (req, res) => {
  if (!env.cronSecret) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
    return;
  }
  if (!authorized(req.get("authorization"))) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid or missing token" } });
    return;
  }
  const published = await runPublishCycle();
  const maintenance = (await claimMaintenanceRun()) ? ((await runMaintenance()) ? "ran" : "skipped") : "not_due";
  res.json({ published, maintenance });
};
