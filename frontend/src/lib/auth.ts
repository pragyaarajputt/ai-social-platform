import { api } from "./api";
import { clearSession, refreshSession, setSession, updateUser, type AuthResult, type User } from "./auth-session";
import type { LoginValues, SignupValues } from "./schemas";

export type { User } from "./auth-session";

/** Restores the session from the refresh cookie. Safe to call more than once. */
export function initSession(): Promise<AuthResult | null> {
  return refreshSession();
}

export async function login(values: LoginValues): Promise<User> {
  const result = await api<AuthResult>("/auth/login", { method: "POST", body: values, auth: false });
  setSession(result);
  return result.user;
}

export async function signup(values: SignupValues): Promise<User> {
  const result = await api<AuthResult>("/auth/register", { method: "POST", body: values, auth: false });
  setSession(result);
  return result.user;
}

export async function logout(): Promise<void> {
  try {
    await api<void>("/auth/logout", { method: "POST", auth: false });
  } finally {
    clearSession();
  }
}

export async function logoutAllDevices(): Promise<void> {
  try {
    await api<void>("/auth/logout-all", { method: "POST" });
  } finally {
    clearSession();
  }
}

/** Re-reads the current user, e.g. after verifying the email in another tab. */
export async function reloadUser(): Promise<void> {
  const { user } = await api<{ user: User }>("/auth/me");
  updateUser(user);
}

export function resendVerification(): Promise<{ message: string }> {
  return api("/auth/resend-verification", { method: "POST" });
}

export function verifyEmail(token: string): Promise<{ message: string }> {
  return api("/auth/verify-email", { method: "POST", body: { token }, auth: false });
}

export function requestPasswordReset(email: string): Promise<{ message: string }> {
  return api("/auth/forgot-password", { method: "POST", body: { email }, auth: false });
}

export function resetPassword(token: string, password: string): Promise<{ message: string }> {
  return api("/auth/reset-password", { method: "POST", body: { token, password }, auth: false });
}

/** Only allow redirects to paths on this site, so `?next=` can't send users elsewhere. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
