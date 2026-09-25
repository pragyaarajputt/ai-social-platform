import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test loads fresh copies of the modules, so in-memory session state doesn't leak between tests.
async function load() {
  vi.resetModules();
  const session = await import("./auth-session");
  const { api, ApiError } = await import("./api");
  return { session, api, ApiError };
}

const user = {
  id: "u1",
  email: "a@example.test",
  username: "alice",
  role: "USER",
  emailVerified: true,
  displayName: "Alice",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const expired = () => json(401, { error: { code: "TOKEN_EXPIRED", message: "Access token has expired" } });
const refreshed = (token: string) => json(200, { user, accessToken: token, expiresIn: 900 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers(); // keep the proactive refresh timer from firing during tests
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path);
const authHeader = (callIndex: number) =>
  (fetchMock.mock.calls[callIndex]![1] as RequestInit).headers as Record<string, string>;

describe("api()", () => {
  it("sends the access token and returns the JSON body", async () => {
    const { session, api } = await load();
    session.setSession({ user, accessToken: "tok-1", expiresIn: 900 } as never);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));

    await expect(api("/things")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/things", expect.anything());
    expect(authHeader(0).Authorization).toBe("Bearer tok-1");
  });

  it("refreshes once and retries when the token has expired", async () => {
    const { session, api } = await load();
    session.setSession({ user, accessToken: "old", expiresIn: 900 } as never);
    fetchMock
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(refreshed("new"))
      .mockResolvedValueOnce(json(200, { ok: true }));

    await expect(api("/things")).resolves.toEqual({ ok: true });
    expect(calls("/api/v1/auth/refresh")).toHaveLength(1);
    expect(authHeader(2).Authorization).toBe("Bearer new");
  });

  it("makes a single refresh call when several requests expire at once", async () => {
    const { session, api } = await load();
    session.setSession({ user, accessToken: "old", expiresIn: 900 } as never);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/auth/refresh") return refreshed("new");
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer new" ? json(200, { url }) : expired();
    });

    const results = await Promise.all([api("/a"), api("/b"), api("/c")]);
    expect(results).toEqual([{ url: "/api/v1/a" }, { url: "/api/v1/b" }, { url: "/api/v1/c" }]);
    expect(calls("/api/v1/auth/refresh")).toHaveLength(1);
  });

  it("signs out and throws when the refresh fails", async () => {
    const { session, api, ApiError } = await load();
    session.setSession({ user, accessToken: "old", expiresIn: 900 } as never);
    fetchMock
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(json(401, { error: { code: "REFRESH_TOKEN_REUSED", message: "Sign in again" } }));

    const error = await api("/things").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).code).toBe("TOKEN_EXPIRED");
    expect(session.sessionStore.getSnapshot().status).toBe("unauthenticated");
    expect(session.getAccessToken()).toBeNull();
  });

  it("does not refresh for other 401 errors", async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: "INVALID_CREDENTIALS", message: "Wrong password" } }));

    await expect(api("/auth/login", { method: "POST", body: {}, auth: false })).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
    expect(calls("/api/v1/auth/refresh")).toHaveLength(0);
  });

  it("parses field errors from a validation response", async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(
      json(400, {
        error: { code: "VALIDATION_ERROR", message: "Some fields are invalid", details: [{ field: "email", message: "Bad" }] },
      }),
    );
    const error = await api("/auth/register", { method: "POST", body: {}, auth: false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", fieldErrors: [{ field: "email", message: "Bad" }] });
  });

  it("reports a friendly error when the server returns non-JSON", async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(api("/things")).rejects.toMatchObject({ status: 502, code: "SERVER_UNAVAILABLE" });
  });

  it("reports a network error when fetch itself fails", async () => {
    const { api } = await load();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api("/things")).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("returns undefined for 204 responses", async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api("/auth/logout", { method: "POST", auth: false })).resolves.toBeUndefined();
  });
});

describe("refreshSession()", () => {
  it("shares one request between concurrent callers (React dev mode runs effects twice)", async () => {
    const { session } = await load();
    fetchMock.mockResolvedValue(refreshed("tok"));

    const [a, b] = await Promise.all([session.refreshSession(), session.refreshSession()]);
    expect(a).toEqual(b);
    expect(calls("/api/v1/auth/refresh")).toHaveLength(1);
    expect(session.sessionStore.getSnapshot()).toEqual({ status: "authenticated", user });
  });

  it("resolves to null and marks the user signed out when there is no session", async () => {
    const { session } = await load();
    fetchMock.mockResolvedValue(json(401, { error: { code: "INVALID_REFRESH_TOKEN", message: "No refresh token" } }));

    await expect(session.refreshSession()).resolves.toBeNull();
    expect(session.sessionStore.getSnapshot().status).toBe("unauthenticated");
  });

  it("schedules a refresh 60 seconds before the token expires", async () => {
    const { session } = await load();
    fetchMock.mockResolvedValue(refreshed("next"));
    session.setSession({ user, accessToken: "first", expiresIn: 900 } as never);

    await vi.advanceTimersByTimeAsync(839_000);
    expect(calls("/api/v1/auth/refresh")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls("/api/v1/auth/refresh")).toHaveLength(1);
  });
});

describe("safeNextPath()", () => {
  it("only allows paths on this site", async () => {
    vi.resetModules();
    const { safeNextPath } = await import("./auth");
    expect(safeNextPath("/account")).toBe("/account");
    expect(safeNextPath("/account?tab=1")).toBe("/account?tab=1");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});
