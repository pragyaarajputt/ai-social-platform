import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { claimMaintenanceRun } from "../src/jobs/maintenance.js";
import { addMedia, connectAccount, createPost, installFakes, signUp, targetOf } from "./support.js";

const SECRET = "test-cron-secret-0123456789abcdef0123456789";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs, job_runs CASCADE");
  installFakes();
  env.cronSecret = SECRET;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  env.cronSecret = undefined;
  vi.restoreAllMocks();
});
afterAll(() => prisma.$disconnect());

const runJobs = (token?: string, method: "post" | "get" = "post") => {
  const req = request(app)[method]("/api/v1/internal/run-jobs");
  return token === undefined ? req : req.set("Authorization", `Bearer ${token}`);
};

describe("run-jobs endpoint (for hosts without an always-on worker)", () => {
  it("doesn't exist unless CRON_SECRET is set", async () => {
    env.cronSecret = undefined;
    expect((await runJobs(SECRET)).status).toBe(404);
  });

  it("refuses calls without the right secret", async () => {
    expect((await runJobs()).status).toBe(401);
    expect((await runJobs("wrong")).status).toBe(401);
    expect((await runJobs(`${SECRET}x`)).status).toBe(401);
    expect((await request(app).post("/api/v1/internal/run-jobs").set("Authorization", SECRET)).status).toBe(401);
  });

  it("publishes posts that are due, like the worker does", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const res = await createPost(u, { caption: "From the scheduler", mediaIds: [(await addMedia(u)).id], targets: [{ socialAccountId: account.id }] });

    const run = await runJobs(SECRET);
    expect(run.status).toBe(200);
    expect(run.body.published).toEqual(["published"]);
    expect((await targetOf(res.body.post.id)).status).toBe("PUBLISHED");
    // Vercel's cron jobs call with GET.
    expect((await runJobs(SECRET, "get")).body.published).toEqual([]);
  });

  it("runs maintenance at most once an hour, however often it's called", async () => {
    expect((await runJobs(SECRET)).body.maintenance).toBe("ran");
    expect((await runJobs(SECRET)).body.maintenance).toBe("not_due");

    // An hour later it's due again, and only one of several simultaneous claims wins.
    const later = new Date(Date.now() + 61 * 60_000);
    const claims = await Promise.all([claimMaintenanceRun(later), claimMaintenanceRun(later), claimMaintenanceRun(later)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
