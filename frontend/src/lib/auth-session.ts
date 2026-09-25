import { toApiError } from "./api-error";

export interface User {
  id: string;
  email: string;
  username: string;
  role: "USER" | "MODERATOR" | "ADMIN";
  emailVerified: boolean;
  displayName: string | null;
  createdAt: string;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  expiresIn: number;
}

export type SessionState =
  | { status: "loading"; user: null }
  | { status: "authenticated"; user: User }
  | { status: "unauthenticated"; user: null };

const LOADING: SessionState = { status: "loading", user: null };
const SIGNED_OUT: SessionState = { status: "unauthenticated", user: null };
const REFRESH_LOCK = "ai-social-auth-refresh";
const REFRESH_EARLY_SECONDS = 60;

// The access token lives only in memory: never in localStorage, where injected scripts could read it.
let accessToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let inflightRefresh: Promise<AuthResult | null> | null = null;

// ─── Store (read by AuthProvider) ───────────────────────────────────────────

let state: SessionState = LOADING;
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export const sessionStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): SessionState => state,
  getServerSnapshot: (): SessionState => LOADING,
};

// ─── Session changes ────────────────────────────────────────────────────────

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSession(result: AuthResult): void {
  accessToken = result.accessToken;
  clearTimeout(refreshTimer);
  // Refresh shortly before the token expires, so requests rarely hit an expired token.
  const delay = Math.max(result.expiresIn - REFRESH_EARLY_SECONDS, 10) * 1000;
  refreshTimer = setTimeout(() => void refreshSession(), delay);
  setState({ status: "authenticated", user: result.user });
}

export function updateUser(user: User): void {
  if (state.status === "authenticated") setState({ status: "authenticated", user });
}

export function clearSession(): void {
  accessToken = null;
  clearTimeout(refreshTimer);
  setState(SIGNED_OUT);
}

// ─── Refresh ────────────────────────────────────────────────────────────────

/**
 * Gets a new access token using the refresh cookie. Resolves to null when not signed in.
 *
 * Only one refresh may run at a time. The server treats a refresh token presented twice as stolen
 * and ends the session, so concurrent refreshes (React dev mode runs effects twice; several tabs
 * can refresh together) would log the user out:
 *  - within this tab, every caller shares the same in-flight request;
 *  - across tabs, the Web Locks API makes tabs take turns, so each one sends the latest cookie.
 */
export function refreshSession(): Promise<AuthResult | null> {
  inflightRefresh ??= withRefreshLock(doRefresh).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function doRefresh(): Promise<AuthResult | null> {
  try {
    const res = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin" });
    if (!res.ok) {
      await toApiError(res); // consume the body
      clearSession();
      return null;
    }
    const result = (await res.json()) as AuthResult;
    setSession(result);
    return result;
  } catch {
    // Network error: treat as signed out rather than leaving the app stuck on "loading".
    clearSession();
    return null;
  }
}

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(REFRESH_LOCK, fn);
  }
  return fn();
}
