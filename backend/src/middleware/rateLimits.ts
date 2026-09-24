import type { Request, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";

// In-memory counters: fine for a single server. Move to a Redis store before running several instances.

function tooMany(message: string) {
  return (_req: Request, res: Response) => {
    res.status(429).json({ error: { code: "TOO_MANY_REQUESTS", message } });
  };
}

const clientIp = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

/** PRD: 5 failed logins for one account from one IP → locked for 15 minutes. Successful logins don't count. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return `${clientIp(req)}:${email}`;
  },
  handler: tooMany("Too many failed sign-in attempts. Try again in 15 minutes."),
});

/** Per-IP cap on endpoints that create accounts or send email. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.rateLimitAuthMax,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: tooMany("Too many requests. Try again later."),
});

/** At most 3 verification emails per user per hour. Runs after requireAuth. */
export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? clientIp(req),
  handler: tooMany("Too many verification emails. Try again in an hour."),
});
