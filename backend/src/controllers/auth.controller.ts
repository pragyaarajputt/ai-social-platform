import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { env } from "../config/env.js";
import * as auth from "../services/auth.service.js";
import type { PublicUser } from "../services/auth.service.js";
import { assertGoogleConfigured, createGoogleAuthRequest, exchangeGoogleCode } from "../services/google-oauth.service.js";
import * as tokens from "../services/token.service.js";
import { AppError } from "../utils/AppError.js";

const REFRESH_COOKIE = "refresh_token";
const GOOGLE_STATE_COOKIE = "google_oauth_state";
const GOOGLE_VERIFIER_COOKIE = "google_oauth_verifier";
/** Where to go after Google sign-in (e.g. back to an invite). */
const GOOGLE_NEXT_COOKIE = "google_oauth_next";

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: "lax",
  path: "/api/v1/auth",
  maxAge: env.refreshTokenTtlDays * 86_400_000,
};

const googleCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: "lax",
  path: "/api/v1/auth/google",
  maxAge: 10 * 60_000,
};

function clientMeta(req: Request): tokens.ClientMeta {
  return { userAgent: req.get("user-agent"), ip: req.ip };
}

/** Cookie-authenticated endpoints only accept requests from our own frontend (CSRF protection). */
function assertTrustedOrigin(req: Request): void {
  const origin = req.get("origin");
  if (origin && origin !== env.corsOrigin) {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "Request origin is not allowed");
  }
}

async function startSession(req: Request, res: Response, user: PublicUser, status = 200): Promise<void> {
  const refreshToken = await tokens.issueRefreshToken(user.id, clientMeta(req));
  const accessToken = await tokens.signAccessToken(user);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
  res.status(status).json({ user, accessToken, expiresIn: env.accessTokenTtlSeconds });
}

export const register: RequestHandler = async (req, res) => {
  const user = await auth.register(req.body);
  await startSession(req, res, user, 201);
};

export const login: RequestHandler = async (req, res) => {
  const user = await auth.login(req.body);
  await startSession(req, res, user);
};

export const refresh: RequestHandler = async (req, res) => {
  assertTrustedOrigin(req);
  const current: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof current !== "string" || !current) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "No refresh token");
  }
  try {
    const { userId, token } = await tokens.rotateRefreshToken(current, clientMeta(req));
    const user = await auth.getUserById(userId);
    res.cookie(REFRESH_COOKIE, token, refreshCookieOptions);
    res.json({ user, accessToken: await tokens.signAccessToken(user), expiresIn: env.accessTokenTtlSeconds });
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path });
    throw err;
  }
};

export const logout: RequestHandler = async (req, res) => {
  assertTrustedOrigin(req);
  const current: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof current === "string" && current) await tokens.revokeRefreshToken(current);
  res.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path });
  res.status(204).end();
};

export const logoutAll: RequestHandler = async (req, res) => {
  await tokens.revokeAllForUser(req.user!.id);
  res.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path });
  res.status(204).end();
};

export const me: RequestHandler = async (req, res) => {
  res.json({ user: await auth.getUserById(req.user!.id) });
};

export const verifyEmail: RequestHandler = async (req, res) => {
  await auth.verifyEmail(req.body.token);
  res.json({ message: "Email verified" });
};

export const resendVerification: RequestHandler = async (req, res) => {
  await auth.resendVerification(req.user!.id);
  res.json({ message: "Verification email sent" });
};

export const forgotPassword: RequestHandler = async (req, res) => {
  await auth.forgotPassword(req.body.email);
  res.json({ message: "If an account exists for that email, a reset link has been sent" });
};

export const resetPassword: RequestHandler = async (req, res) => {
  await auth.resetPassword(req.body.token, req.body.password);
  res.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path });
  res.json({ message: "Password updated. Please sign in again." });
};

/** A page on our own site to continue to after signing in (e.g. an invite link); anything else is "/". */
function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.length > 500) return "/";
  return next;
}

/** Google sign-in is a browser navigation, so every problem becomes a message on the login page. */
const backToLogin = (res: Response, error: string) => res.redirect(`${env.appUrl}/login?error=${error}`);

export const googleStart: RequestHandler = (req, res) => {
  let request: ReturnType<typeof createGoogleAuthRequest>;
  try {
    request = createGoogleAuthRequest();
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_CONFIGURED") return backToLogin(res, "google_unavailable");
    throw err;
  }
  res.cookie(GOOGLE_STATE_COOKIE, request.state, googleCookieOptions);
  res.cookie(GOOGLE_VERIFIER_COOKIE, request.codeVerifier, googleCookieOptions);
  res.cookie(GOOGLE_NEXT_COOKIE, safeNextPath(req.query.next), googleCookieOptions);
  res.redirect(request.url);
};

export const googleCallback: RequestHandler = async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState: unknown = req.cookies?.[GOOGLE_STATE_COOKIE];
  const verifier: unknown = req.cookies?.[GOOGLE_VERIFIER_COOKIE];
  const next = safeNextPath(req.cookies?.[GOOGLE_NEXT_COOKIE]);
  for (const name of [GOOGLE_STATE_COOKIE, GOOGLE_VERIFIER_COOKIE, GOOGLE_NEXT_COOKIE]) res.clearCookie(name, { path: googleCookieOptions.path });

  try {
    assertGoogleConfigured();
  } catch {
    return backToLogin(res, "google_unavailable");
  }
  // The person pressed Cancel on Google's screen (error=access_denied).
  if (typeof error === "string") return backToLogin(res, "google_cancelled");
  // No cookies (over 10 minutes, or finished in another browser) or a state that isn't ours.
  if (typeof code !== "string" || typeof state !== "string" || typeof expectedState !== "string" || typeof verifier !== "string" || state !== expectedState) {
    return backToLogin(res, "google_expired");
  }

  try {
    const profile = await exchangeGoogleCode(code, verifier);
    const user = await auth.loginWithGoogle(profile);
    const refreshToken = await tokens.issueRefreshToken(user.id, clientMeta(req));
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
    // The frontend calls POST /auth/refresh on this page to get an access token, then goes to `next`.
    res.redirect(`${env.appUrl}/auth/callback?next=${encodeURIComponent(next)}`);
  } catch (err) {
    if (err instanceof AppError && err.code === "EMAIL_TAKEN") return backToLogin(res, "google_email_taken");
    if (err instanceof AppError && err.code === "ACCOUNT_DISABLED") return backToLogin(res, "account_disabled");
    console.error("Google sign-in failed:", err);
    backToLogin(res, "oauth_failed");
  }
};
