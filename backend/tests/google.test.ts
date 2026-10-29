// Google sign-in with Google faked: the service that talks to Google is replaced, so these tests cover
// our side of the flow (cookies, state, where people end up) without network calls.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleProfile } from "../src/services/google-oauth.service.js";

const google = vi.hoisted(() => ({
  profile: null as GoogleProfile | null,
  exchanges: [] as { code: string; verifier: string }[],
}));

vi.mock("../src/services/google-oauth.service.js", () => ({
  assertGoogleConfigured: () => undefined,
  createGoogleAuthRequest: () => ({
    url: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
    state: "test-state",
    codeVerifier: "test-verifier",
  }),
  exchangeGoogleCode: async (code: string, verifier: string) => {
    google.exchanges.push({ code, verifier });
    if (!google.profile) throw new Error("Google rejected the code");
    return google.profile;
  },
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/config/database.js");
const { env } = await import("../src/config/env.js");

const API = "/api/v1/auth";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  google.profile = { sub: "google-123", email: "pragya@example.com", emailVerified: true, name: "Pragya Rajput" };
  google.exchanges = [];
});
afterAll(() => prisma.$disconnect());

/** Starts sign-in like the browser does and returns the cookies Google's redirect back would carry. */
async function start(query = "") {
  const res = await request(app).get(`${API}/google${query}`);
  expect(res.status).toBe(302);
  expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return cookies.map((c) => c.split(";")[0]).join("; ");
}
const callback = (cookies: string, query = "code=good-code&state=test-state") => request(app).get(`${API}/google/callback?${query}`).set("Cookie", cookies);

describe("Google sign-in", () => {
  it("signs up a new person: creates the account, sets the session cookie and lands on the app", async () => {
    const res = await callback(await start());
    expect(res.headers.location).toBe(`${env.appUrl}/auth/callback?next=%2F`);
    expect(String(res.headers["set-cookie"])).toContain("refresh_token=");
    expect(google.exchanges).toEqual([{ code: "good-code", verifier: "test-verifier" }]);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "pragya@example.com" }, include: { oauthAccounts: true, memberships: true } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.oauthAccounts).toMatchObject([{ provider: "google", providerAccountId: "google-123" }]);
    expect(user.memberships).toHaveLength(1);
  });

  it("logs in the same person next time instead of creating a second account", async () => {
    await callback(await start());
    const again = await callback(await start());
    expect(again.headers.location).toBe(`${env.appUrl}/auth/callback?next=%2F`);
    expect(await prisma.user.count()).toBe(1);
  });

  it("links Google to an existing email-and-password account when Google has verified the email", async () => {
    await request(app).post(`${API}/register`).send({ email: "pragya@example.com", username: "pragya", password: "a-long-password-123", displayName: "Pragya" });
    const res = await callback(await start());
    expect(res.headers.location).toContain("/auth/callback");
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.oAuthAccount.count()).toBe(1);
  });

  it("says so when the email belongs to an account and Google hasn't verified it", async () => {
    await request(app).post(`${API}/register`).send({ email: "pragya@example.com", username: "pragya", password: "a-long-password-123", displayName: "Pragya" });
    google.profile = { ...google.profile!, emailVerified: false };
    const res = await callback(await start());
    expect(res.headers.location).toBe(`${env.appUrl}/login?error=google_email_taken`);
  });

  it("returns to the page the person came from, such as an invite, and only to our own pages", async () => {
    const invite = await callback(await start(`?next=${encodeURIComponent("/invite/abc123")}`));
    expect(invite.headers.location).toBe(`${env.appUrl}/auth/callback?next=%2Finvite%2Fabc123`);
    for (const outside of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      const res = await callback(await start(`?next=${encodeURIComponent(outside)}`));
      expect(res.headers.location).toBe(`${env.appUrl}/auth/callback?next=%2F`);
    }
  });

  it("explains a cancel, an expired attempt and a forged state, without signing anyone in", async () => {
    const cookies = await start();
    expect((await callback(cookies, "error=access_denied&state=test-state")).headers.location).toBe(`${env.appUrl}/login?error=google_cancelled`);
    // No cookies: the attempt took over 10 minutes or finished in another browser.
    expect((await callback("", "code=good-code&state=test-state")).headers.location).toBe(`${env.appUrl}/login?error=google_expired`);
    expect((await callback(await start(), "code=good-code&state=someone-elses")).headers.location).toBe(`${env.appUrl}/login?error=google_expired`);
    expect(google.exchanges).toHaveLength(0);
    expect(await prisma.user.count()).toBe(0);
  });

  it("falls back to a general message when Google rejects the code", async () => {
    google.profile = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await callback(await start())).headers.location).toBe(`${env.appUrl}/login?error=oauth_failed`);
  });
});
