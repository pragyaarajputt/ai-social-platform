import { config } from "dotenv";
import { z } from "zod";

// Tests load .env.test through vitest.config.ts; never let the dev .env leak into them.
if (process.env.NODE_ENV !== "test") config({ quiet: true });

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.url().default("http://localhost:3000"),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),

  SMTP_URL: optional,
  EMAIL_FROM: z.string().default("AI Social <no-reply@localhost>"),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: optional,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

const e = parsed.data;

export const env = {
  nodeEnv: e.NODE_ENV,
  isProduction: e.NODE_ENV === "production",
  isTest: e.NODE_ENV === "test",
  port: e.PORT,
  corsOrigin: e.CORS_ORIGIN,
  appUrl: e.APP_URL,
  databaseUrl: e.DATABASE_URL,
  jwtAccessSecret: e.JWT_ACCESS_SECRET,
  accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
  rateLimitAuthMax: e.RATE_LIMIT_AUTH_MAX,
  smtpUrl: e.SMTP_URL,
  emailFrom: e.EMAIL_FROM,
  google:
    e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REDIRECT_URI
      ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUri: e.GOOGLE_REDIRECT_URI }
      : undefined,
};
