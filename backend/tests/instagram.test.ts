import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { refreshDueTokens } from "../src/services/tokenRefresh.service.js";
import { hashToken } from "../src/utils/crypto.js";
import { parseSignedRequest } from "../src/utils/metaSignedRequest.js";
import { decryptToken, encryptToken } from "../src/utils/tokenCrypto.js";

// ─── Fake Instagram ─────────────────────────────────────────────────────────
// Replaces global fetch for Instagram hosts only. supertest talks to the app over plain HTTP,
// so it isn't affected.

interface FakeState {
  accountType: string;
  meCalls: number;
  refreshResponse: { status: number; body: unknown };
}
let fake: FakeState;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFakeInstagram() {
  fake = {
    accountType: "Business",
    meCalls: 0,
    refreshResponse: { status: 200, body: { access_token: "long-token-2", token_type: "bearer", expires_in: 5_184_000 } },
  };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "api.instagram.com" && url.pathname === "/oauth/access_token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_secret") !== env.instagram!.appSecret) return json(400, { error_message: "bad secret" });
      if (form.get("code") !== "good-code") {
        return json(400, { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" });
      }
      return json(200, {
        data: [{ access_token: "short-token", user_id: "999", permissions: "instagram_business_basic,instagram_business_content_publish" }],
      });
    }
    if (url.host === "graph.instagram.com" && url.pathname === "/access_token") {
      expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
      expect(url.searchParams.get("access_token")).toBe("short-token");
      return json(200, { access_token: "long-token-1", token_type: "bearer", expires_in: 5_184_000 });
    }
    if (url.host === "graph.instagram.com" && url.pathname === `/${env.instagram!.graphVersion}/me`) {
      fake.meCalls++;
      return json(200, {
        id: "app-scoped-1",
        user_id: "17841400000000001",
        username: "testbrand",
        name: "Test Brand",
        account_type: fake.accountType,
        profile_picture_url: "https://cdn.example/avatar.jpg",
      });
    }
    if (url.host === "graph.instagram.com" && url.pathname === "/refresh_access_token") {
      return json(fake.refreshResponse.status, fake.refreshResponse.body);
    }
    if (url.host.endsWith("instagram.com")) throw new Error(`Unexpected Instagram call: ${url.pathname}`);
    return realFetch(input, init);
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
async function signUp() {
  seq += 1;
  const id = `${Date.now().toString(36)}${seq}`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ email: `ig${id}@example.test`, username: `ig_${id}`, password: "correct horse battery", displayName: "Owner" });
  expect(res.status).toBe(201);
  const token = res.body.accessToken as string;
  const ws = await request(app).get("/api/v1/workspaces").set("Authorization", `Bearer ${token}`);
  return { token, userId: res.body.user.id as string, workspaceId: ws.body.workspaces[0].id as string };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function startConnect(user: { token: string; workspaceId: string }) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${user.workspaceId}/social-accounts/instagram/connect`)
    .set(auth(user.token));
  expect(res.status).toBe(200);
  return new URL(res.body.authorizationUrl).searchParams.get("state")!;
}

function callback(query: Record<string, string>) {
  return request(app).get(`/api/v1/integrations/instagram/callback?${new URLSearchParams(query)}`);
}

async function connectInstagram(user: { token: string; workspaceId: string }) {
  const state = await startConnect(user);
  const res = await callback({ code: "good-code", state });
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`${env.appUrl}/accounts?connected=instagram`);
  return prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: user.workspaceId }, include: { token: true } });
}

function signedRequest(payload: object, secret = env.instagram!.appSecret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${sig}.${body}`;
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakeInstagram();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("token encryption", () => {
  it("round-trips, uses a fresh IV each time, and rejects tampering", () => {
    const a = encryptToken("secret-token");
    const b = encryptToken("secret-token");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("secret-token");
    expect(decryptToken(a)).toBe("secret-token");

    const parts = a.split(":");
    const flipped = parts[3]!.startsWith("A") ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
    expect(() => decryptToken([parts[0], parts[1], parts[2], flipped].join(":"))).toThrow();
    expect(() => decryptToken(`v9:${parts.slice(1).join(":")}`)).toThrow();
  });
});

describe("Meta signed_request", () => {
  it("accepts a correctly signed request and rejects anything else", () => {
    const secret = env.instagram!.appSecret;
    expect(parseSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", user_id: "42" }), secret)).toMatchObject({ user_id: "42" });
    expect(parseSignedRequest(signedRequest({ algorithm: "HMAC-SHA256", user_id: "42" }, "wrong-secret"), secret)).toBeNull();
    expect(parseSignedRequest(signedRequest({ algorithm: "none", user_id: "42" }), secret)).toBeNull();
    expect(parseSignedRequest("garbage", secret)).toBeNull();
    expect(parseSignedRequest(undefined, secret)).toBeNull();
  });
});

describe("workspaces", () => {
  it("gives every new user a personal workspace they own", async () => {
    const { token } = await signUp();
    const res = await request(app).get("/api/v1/workspaces").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0]).toMatchObject({ name: "Owner's workspace", role: "OWNER", timezone: "UTC" });
    expect(res.body.workspaces[0].slug).toMatch(/^ws-[0-9a-f]{12}$/);
  });

  it("hides other users' workspaces (404) and rejects malformed IDs", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const probe = await request(app).get(`/api/v1/workspaces/${alice.workspaceId}/social-accounts`).set(auth(bob.token));
    expect(probe.status).toBe(404);
    const malformed = await request(app).get("/api/v1/workspaces/not-a-uuid/social-accounts").set(auth(bob.token));
    expect(malformed.status).toBe(404);
  });

  it("requires ADMIN to connect accounts; VIEWERs can only list", async () => {
    const owner = await signUp();
    const viewer = await signUp();
    await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: "VIEWER" } });

    const list = await request(app).get(`/api/v1/workspaces/${owner.workspaceId}/social-accounts`).set(auth(viewer.token));
    expect(list.status).toBe(200);
    const connect = await request(app)
      .post(`/api/v1/workspaces/${owner.workspaceId}/social-accounts/instagram/connect`)
      .set(auth(viewer.token));
    expect(connect.status).toBe(403);
    expect(connect.body.error.code).toBe("INSUFFICIENT_ROLE");
  });
});

describe("connecting Instagram", () => {
  it("builds the Instagram authorize URL and stores only a hash of the state", async () => {
    const user = await signUp();
    const res = await request(app)
      .post(`/api/v1/workspaces/${user.workspaceId}/social-accounts/instagram/connect`)
      .set(auth(user.token));
    const url = new URL(res.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(env.instagram!.appId);
    expect(url.searchParams.get("redirect_uri")).toBe(env.instagram!.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights");

    const state = url.searchParams.get("state")!;
    const stored = await prisma.oAuthConnectState.findUniqueOrThrow({ where: { stateHash: hashToken(state) } });
    expect(stored).toMatchObject({ workspaceId: user.workspaceId, userId: user.userId, platform: "INSTAGRAM", usedAt: null });
  });

  it("rejects unknown platforms and unauthenticated requests", async () => {
    const user = await signUp();
    const unknown = await request(app)
      .post(`/api/v1/workspaces/${user.workspaceId}/social-accounts/myspace/connect`)
      .set(auth(user.token));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("PLATFORM_NOT_SUPPORTED");
    const anonymous = await request(app).post(`/api/v1/workspaces/${user.workspaceId}/social-accounts/instagram/connect`);
    expect(anonymous.status).toBe(401);
  });

  it("completes the flow: long-lived token stored encrypted, account listed without secrets", async () => {
    const user = await signUp();
    const account = await connectInstagram(user);

    expect(account).toMatchObject({
      platform: "INSTAGRAM",
      externalId: "17841400000000001",
      appScopedId: "app-scoped-1",
      accountType: "BUSINESS",
      username: "testbrand",
      status: "ACTIVE",
      connectedById: user.userId,
    });
    expect(account.token!.accessTokenEnc).not.toContain("long-token-1");
    expect(decryptToken(account.token!.accessTokenEnc)).toBe("long-token-1");
    expect(account.token!.scopes).toEqual(["instagram_business_basic", "instagram_business_content_publish"]);
    // The user didn't grant the insights permission, so analytics stays off for this account.
    expect(account.insightsAllowed).toBe(false);
    const daysLeft = (account.token!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(59);

    const list = await request(app).get(`/api/v1/workspaces/${user.workspaceId}/social-accounts`).set(auth(user.token));
    expect(list.status).toBe(200);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0]).toMatchObject({ username: "testbrand", status: "ACTIVE", accountType: "BUSINESS" });
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain("long-token");
    expect(raw).not.toContain("accessTokenEnc");
    expect(list.body.platforms).toEqual([{ platform: "INSTAGRAM", displayName: "Instagram", configured: true }]);

    const log = await prisma.auditLog.findFirst({ where: { action: "social_account.connected" } });
    expect(log).toMatchObject({ workspaceId: user.workspaceId, actorId: user.userId, targetId: account.id });
  });

  it("rejects a state it didn't issue, and a state used twice", async () => {
    const user = await signUp();
    const forged = await callback({ code: "good-code", state: "not-a-real-state" });
    expect(forged.headers.location).toContain("error=invalid_state");

    const state = await startConnect(user);
    expect((await callback({ code: "good-code", state })).headers.location).toContain("connected=instagram");
    const replay = await callback({ code: "good-code", state });
    expect(replay.headers.location).toContain("error=invalid_state");
  });

  it("rejects an expired state", async () => {
    const user = await signUp();
    const state = await startConnect(user);
    await prisma.oAuthConnectState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await callback({ code: "good-code", state });
    expect(res.headers.location).toContain("error=invalid_state");
    expect(await prisma.socialAccount.count()).toBe(0);
  });

  it("reports when the user cancels on Instagram", async () => {
    const user = await signUp();
    const state = await startConnect(user);
    const res = await callback({ error: "access_denied", error_reason: "user_denied", state });
    expect(res.headers.location).toBe(`${env.appUrl}/accounts?error=cancelled&platform=instagram`);
  });

  it("refuses personal accounts", async () => {
    const user = await signUp();
    fake.accountType = "Personal";
    const state = await startConnect(user);
    const res = await callback({ code: "good-code", state });
    expect(res.headers.location).toContain("error=unsupported_account");
    expect(await prisma.socialAccount.count()).toBe(0);
  });

  it("reports Instagram errors, e.g. an invalid code", async () => {
    const user = await signUp();
    const state = await startConnect(user);
    const res = await callback({ code: "bad-code", state });
    expect(res.headers.location).toContain("error=platform_error");
  });

  it("updates the existing account on reconnect instead of duplicating it", async () => {
    const user = await signUp();
    const first = await connectInstagram(user);
    await prisma.socialAccount.update({ where: { id: first.id }, data: { status: "NEEDS_REAUTH" } });

    const second = await connectInstagram(user);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("ACTIVE");
    expect(await prisma.socialAccount.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "social_account.reconnected" } })).toBe(1);
  });

  it("disconnects: deletes the token and hides the account", async () => {
    const user = await signUp();
    const account = await connectInstagram(user);

    const other = await signUp();
    const cross = await request(app)
      .delete(`/api/v1/workspaces/${other.workspaceId}/social-accounts/${account.id}`)
      .set(auth(other.token));
    expect(cross.status).toBe(404);

    const res = await request(app)
      .delete(`/api/v1/workspaces/${user.workspaceId}/social-accounts/${account.id}`)
      .set(auth(user.token));
    expect(res.status).toBe(204);
    expect(await prisma.oAuthToken.count()).toBe(0);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("DISCONNECTED");

    const list = await request(app).get(`/api/v1/workspaces/${user.workspaceId}/social-accounts`).set(auth(user.token));
    expect(list.body.accounts).toHaveLength(0);
  });
});

describe("token refresh", () => {
  async function connectedWithToken(tokenFields: { expiresAt: Date; lastRefreshedAt: Date; failureCount?: number }) {
    const user = await signUp();
    const account = await connectInstagram(user);
    await prisma.oAuthToken.update({ where: { socialAccountId: account.id }, data: tokenFields });
    return account;
  }
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);

  it("refreshes tokens that expire soon and are at least 24 hours old", async () => {
    const account = await connectedWithToken({ expiresAt: days(5), lastRefreshedAt: days(-2) });
    const summary = await refreshDueTokens();
    expect(summary).toMatchObject({ checked: 1, refreshed: 1 });

    const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } });
    expect(decryptToken(token.accessTokenEnc)).toBe("long-token-2");
    expect(token.expiresAt!.getTime()).toBeGreaterThan(days(59).getTime());
  });

  it("leaves tokens alone that don't expire soon, or are under 24 hours old", async () => {
    await connectedWithToken({ expiresAt: days(30), lastRefreshedAt: days(-2) });
    await connectedWithToken({ expiresAt: days(5), lastRefreshedAt: new Date(Date.now() - 3_600_000) });
    const summary = await refreshDueTokens();
    expect(summary).toMatchObject({ checked: 1, refreshed: 0, skipped: 1 });
  });

  it("asks for a reconnect when Instagram rejects the token", async () => {
    const account = await connectedWithToken({ expiresAt: days(5), lastRefreshedAt: days(-2) });
    fake.refreshResponse = { status: 400, body: { error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } } };
    const summary = await refreshDueTokens();
    expect(summary.needsReauth).toBe(1);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
    expect(await prisma.auditLog.count({ where: { action: "social_account.token_refresh_failed" } })).toBe(1);
  });

  it("retries temporary errors, then asks for a reconnect after 3 failures", async () => {
    const account = await connectedWithToken({ expiresAt: days(5), lastRefreshedAt: days(-2) });
    fake.refreshResponse = { status: 500, body: { error: { message: "Service unavailable", code: 2 } } };

    expect((await refreshDueTokens()).failed).toBe(1);
    expect((await refreshDueTokens()).failed).toBe(1);
    const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } });
    expect(token.failureCount).toBe(2);
    expect(token.lastError).toContain("Service unavailable");

    expect((await refreshDueTokens()).needsReauth).toBe(1);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("marks already-expired tokens for reconnect without calling Instagram", async () => {
    const account = await connectedWithToken({ expiresAt: days(-1), lastRefreshedAt: days(-61) });
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    const summary = await refreshDueTokens();
    expect(summary.needsReauth).toBe(1);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
  });
});

describe("Meta callbacks", () => {
  it("deauthorize: revokes the account and deletes its token", async () => {
    const account = await connectInstagram(await signUp());
    const res = await request(app)
      .post("/api/v1/integrations/instagram/deauthorize")
      .type("form")
      .send({ signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: "app-scoped-1", issued_at: 1 }) });
    expect(res.status).toBe(200);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("REVOKED");
    expect(await prisma.oAuthToken.count()).toBe(0);
  });

  it("rejects a request with a bad signature", async () => {
    await connectInstagram(await signUp());
    const res = await request(app)
      .post("/api/v1/integrations/instagram/deauthorize")
      .type("form")
      .send({ signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: "app-scoped-1" }, "not-the-secret") });
    expect(res.status).toBe(400);
    expect(await prisma.oAuthToken.count()).toBe(1);
  });

  it("data deletion: deletes the account and returns a status URL and confirmation code", async () => {
    await connectInstagram(await signUp());
    const res = await request(app)
      .post("/api/v1/integrations/instagram/data-deletion")
      .type("form")
      .send({ signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: "app-scoped-1" }) });
    expect(res.status).toBe(200);
    expect(res.body.confirmation_code).toMatch(/^[\w-]{16}$/);
    expect(await prisma.socialAccount.count()).toBe(0);

    const status = await request(app).get(new URL(res.body.url).pathname);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("completed");
  });
});
