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
  // Express "trust proxy": which proxies may set X-Forwarded-For. Needed so rate limits see real client IPs
  // when requests arrive through the Next.js rewrite. e.g. "loopback", a hop count like "1", or unset.
  TRUST_PROXY: optional,

  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),

  SMTP_URL: optional,
  EMAIL_FROM: z.string().default("AI Social <no-reply@localhost>"),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_REDIRECT_URI: optional,

  // 32 random bytes, base64. Encrypts social account tokens at rest (utils/tokenCrypto.ts).
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),

  // Instagram API with Instagram Login. Connecting Instagram is off unless all three are set.
  INSTAGRAM_APP_ID: optional,
  INSTAGRAM_APP_SECRET: optional,
  INSTAGRAM_REDIRECT_URI: optional,
  INSTAGRAM_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
});

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

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
  trustProxy: parseTrustProxy(e.TRUST_PROXY),
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
  tokenEncryptionKey: Buffer.from(e.TOKEN_ENCRYPTION_KEY, "base64"),
  instagram:
    e.INSTAGRAM_APP_ID && e.INSTAGRAM_APP_SECRET && e.INSTAGRAM_REDIRECT_URI
      ? {
          appId: e.INSTAGRAM_APP_ID,
          appSecret: e.INSTAGRAM_APP_SECRET,
          redirectUri: e.INSTAGRAM_REDIRECT_URI,
          graphVersion: e.INSTAGRAM_GRAPH_VERSION,
        }
      : undefined,
};
