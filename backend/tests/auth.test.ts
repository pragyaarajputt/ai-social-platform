import { SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { testOutbox } from "../src/services/email.service.js";

const API = "/api/v1/auth";
let seq = 0;

function newUser(overrides: Partial<Record<"email" | "username" | "password" | "displayName", string>> = {}) {
  seq += 1;
  const id = `${Date.now().toString(36)}${seq}`;
  return {
    email: `user${id}@example.test`,
    username: `user_${id}`,
    password: "correct horse battery",
    displayName: "Test User",
    ...overrides,
  };
}

function refreshCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const cookie = cookies.find((c) => c.startsWith("refresh_token="));
  if (!cookie) throw new Error("no refresh_token cookie in response");
  return cookie.split(";")[0]!;
}

function tokenFromLastEmail(): string {
  const email = testOutbox.at(-1);
  if (!email) throw new Error("no email sent");
  const match = /token=([^\s&]+)/.exec(email.text);
  if (!match?.[1]) throw new Error("no token in email");
  return decodeURIComponent(match[1]);
}

async function register(overrides = {}) {
  const body = newUser(overrides);
  const res = await request(app).post(`${API}/register`).send(body);
  expect(res.status).toBe(201);
  return { body, res, accessToken: res.body.accessToken as string, cookie: refreshCookie(res) };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces CASCADE");
  testOutbox.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("register", () => {
  it("creates the user, profile and settings, and starts a session", async () => {
    const { body, res } = await register({ username: "New_User_1" });

    expect(res.body.user).toMatchObject({
      email: body.email,
      username: "new_user_1", // stored lowercase
      role: "USER",
      emailVerified: false,
      displayName: "Test User",
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);

    const row = await prisma.user.findUniqueOrThrow({
      where: { email: body.email },
      include: { profile: true, settings: true },
    });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.profile).not.toBeNull();
    expect(row.settings).not.toBeNull();
  });

  it("sets the refresh cookie as httpOnly, SameSite=Lax, scoped to the auth path", async () => {
    const { res } = await register();
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("refresh_token="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\/api\/v1\/auth/);
  });

  it("sends a verification email", async () => {
    const { body } = await register();
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]!.to).toBe(body.email);
    expect(testOutbox[0]!.text).toContain(`${env.appUrl}/verify-email?token=`);
  });

  it("rejects a duplicate email (case-insensitive)", async () => {
    const { body } = await register();
    const res = await request(app)
      .post(`${API}/register`)
      .send(newUser({ email: body.email.toUpperCase() }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects a duplicate username (case-insensitive)", async () => {
    await register({ username: "taken_name" });
    const res = await request(app).post(`${API}/register`).send(newUser({ username: "Taken_Name" }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("USERNAME_TAKEN");
  });

  it("returns field-level validation errors", async () => {
    const res = await request(app)
      .post(`${API}/register`)
      .send({ email: "not-an-email", username: "a!", password: "short", displayName: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["email", "username", "password", "displayName"]));
  });

  it("rejects malformed JSON", async () => {
    const res = await request(app).post(`${API}/register`).set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});

describe("login", () => {
  it("signs in with the correct password", async () => {
    const { body } = await register();
    const res = await request(app).post(`${API}/login`).send({ email: body.email, password: body.password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(body.email);
    expect(refreshCookie(res)).toMatch(/^refresh_token=/);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const { body } = await register();
    const wrong = await request(app).post(`${API}/login`).send({ email: body.email, password: "wrong password" });
    const unknown = await request(app).post(`${API}/login`).send({ email: "nobody@example.test", password: "whatever1" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it("locks the account for this IP after 5 failed attempts, even for the right password", async () => {
    const { body } = await register();
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post(`${API}/login`).send({ email: body.email, password: "wrong password" });
      expect(res.status).toBe(401);
    }
    const locked = await request(app).post(`${API}/login`).send({ email: body.email, password: body.password });
    expect(locked.status).toBe(429);
  });

  it("refuses suspended accounts", async () => {
    const { body } = await register();
    await prisma.user.update({ where: { email: body.email }, data: { status: "SUSPENDED" } });
    const res = await request(app).post(`${API}/login`).send({ email: body.email, password: body.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("GET /me (requireAuth)", () => {
  it("returns the signed-in user", async () => {
    const { body, accessToken } = await register();
    const res = await request(app).get(`${API}/me`).set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(body.email);
  });

  it("rejects a missing token", async () => {
    const res = await request(app).get(`${API}/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a tampered token", async () => {
    const { accessToken } = await register();
    const res = await request(app).get(`${API}/me`).set("Authorization", `Bearer ${accessToken}x`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects an expired token", async () => {
    const { res: reg } = await register();
    const expired = await new SignJWT({ role: "USER" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(reg.body.user.id)
      .setIssuer("ai-social-api")
      .setAudience("ai-social-web")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(env.jwtAccessSecret));
    const res = await request(app).get(`${API}/me`).set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });
});

describe("refresh tokens", () => {
  it("rotates: returns a new access token and a new cookie", async () => {
    const { cookie } = await register();
    const res = await request(app).post(`${API}/refresh`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(res)).not.toBe(cookie);
  });

  it("detects reuse of an old token and revokes the whole session", async () => {
    const { cookie: first } = await register();
    const rotated = await request(app).post(`${API}/refresh`).set("Cookie", first);
    const second = refreshCookie(rotated);

    const reuse = await request(app).post(`${API}/refresh`).set("Cookie", first);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // The legitimate newer token is revoked too.
    const after = await request(app).post(`${API}/refresh`).set("Cookie", second);
    expect(after.status).toBe(401);
  });

  it("rejects requests from another origin", async () => {
    const { cookie } = await register();
    const res = await request(app).post(`${API}/refresh`).set("Cookie", cookie).set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rejects a request with no cookie", async () => {
    const res = await request(app).post(`${API}/refresh`);
    expect(res.status).toBe(401);
  });
});

describe("logout", () => {
  it("revokes the current session", async () => {
    const { cookie } = await register();
    const out = await request(app).post(`${API}/logout`).set("Cookie", cookie);
    expect(out.status).toBe(204);
    const res = await request(app).post(`${API}/refresh`).set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("logout-all revokes every session", async () => {
    const { body, accessToken, cookie: sessionA } = await register();
    const loginB = await request(app).post(`${API}/login`).send({ email: body.email, password: body.password });
    const sessionB = refreshCookie(loginB);

    const out = await request(app).post(`${API}/logout-all`).set("Authorization", `Bearer ${accessToken}`);
    expect(out.status).toBe(204);

    for (const cookie of [sessionA, sessionB]) {
      const res = await request(app).post(`${API}/refresh`).set("Cookie", cookie);
      expect(res.status).toBe(401);
    }
  });
});

describe("email verification", () => {
  it("verifies with the emailed token, which then can't be reused", async () => {
    const { accessToken } = await register();
    const token = tokenFromLastEmail();

    const ok = await request(app).post(`${API}/verify-email`).send({ token });
    expect(ok.status).toBe(200);

    const me = await request(app).get(`${API}/me`).set("Authorization", `Bearer ${accessToken}`);
    expect(me.body.user.emailVerified).toBe(true);

    const again = await request(app).post(`${API}/verify-email`).send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
  });

  it("rejects an expired token", async () => {
    await register();
    const token = tokenFromLastEmail();
    await prisma.verificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post(`${API}/verify-email`).send({ token });
    expect(res.status).toBe(400);
  });

  it("resend invalidates the previous link and is limited to 3 per hour", async () => {
    const { accessToken } = await register();
    const firstToken = tokenFromLastEmail();

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post(`${API}/resend-verification`).set("Authorization", `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
    }
    const limited = await request(app).post(`${API}/resend-verification`).set("Authorization", `Bearer ${accessToken}`);
    expect(limited.status).toBe(429);

    const old = await request(app).post(`${API}/verify-email`).send({ token: firstToken });
    expect(old.status).toBe(400);
    const latest = await request(app).post(`${API}/verify-email`).send({ token: tokenFromLastEmail() });
    expect(latest.status).toBe(200);
  });
});

describe("password reset", () => {
  it("returns 200 and sends nothing for an unknown email", async () => {
    const res = await request(app).post(`${API}/forgot-password`).send({ email: "nobody@example.test" });
    expect(res.status).toBe(200);
    expect(testOutbox).toHaveLength(0);
  });

  it("resets the password, signs out every session, and the link works once", async () => {
    const { body, cookie } = await register();
    testOutbox.length = 0;

    const forgot = await request(app).post(`${API}/forgot-password`).send({ email: body.email });
    expect(forgot.status).toBe(200);
    expect(testOutbox[0]!.text).toContain(`${env.appUrl}/reset-password?token=`);
    const token = tokenFromLastEmail();

    const reset = await request(app).post(`${API}/reset-password`).send({ token, password: "a brand new password" });
    expect(reset.status).toBe(200);

    expect((await request(app).post(`${API}/refresh`).set("Cookie", cookie)).status).toBe(401);
    expect((await request(app).post(`${API}/login`).send({ email: body.email, password: body.password })).status).toBe(401);
    expect(
      (await request(app).post(`${API}/login`).send({ email: body.email, password: "a brand new password" })).status,
    ).toBe(200);

    const reuse = await request(app).post(`${API}/reset-password`).send({ token, password: "another password" });
    expect(reuse.status).toBe(400);
  });

  it("does not accept an email-verification token as a reset token", async () => {
    await register();
    const verifyToken = tokenFromLastEmail();
    const res = await request(app).post(`${API}/reset-password`).send({ token: verifyToken, password: "whatever123" });
    expect(res.status).toBe(400);
  });
});

describe("Google sign-in", () => {
  // The configured flow is in google.test.ts, with Google faked.
  it("sends people back to the login page with a message when Google isn't set up", async () => {
    const start = await request(app).get(`${API}/google`);
    expect(start.status).toBe(302);
    expect(start.headers.location).toBe(`${env.appUrl}/login?error=google_unavailable`);

    const callback = await request(app).get(`${API}/google/callback?code=x&state=y`);
    expect(callback.headers.location).toBe(`${env.appUrl}/login?error=google_unavailable`);
  });
});

describe("health", () => {
  it("/ready reports the database is up", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("up");
  });
});
