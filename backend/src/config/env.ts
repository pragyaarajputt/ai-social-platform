import { config } from "dotenv";
import { z } from "zod";
import { parseKeyRing } from "../utils/keyRing.js";

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

  // Encrypt social account tokens at rest (utils/tokenCrypto.ts). Either one key (32 random bytes,
  // base64) or, to rotate keys, a list "v2:<key>,v1:<old key>" whose first key encrypts new data.
  TOKEN_ENCRYPTION_KEY: optional,
  TOKEN_ENCRYPTION_KEYS: optional,

  // Instagram API with Instagram Login. Connecting Instagram is off unless all three are set.
  INSTAGRAM_APP_ID: optional,
  INSTAGRAM_APP_SECRET: optional,
  INSTAGRAM_REDIRECT_URI: optional,
  INSTAGRAM_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),

  // Facebook Pages (Facebook Login for Business). Connecting Facebook is off unless the first three are set.
  FACEBOOK_APP_ID: optional,
  FACEBOOK_APP_SECRET: optional,
  FACEBOOK_REDIRECT_URI: optional,
  /** Login configuration from the App Dashboard (Facebook Login for Business). Without it, scopes are requested directly. */
  FACEBOOK_CONFIG_ID: optional,
  FACEBOOK_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),

  // Cloudinary media storage. Uploading media is off unless all three are set.
  CLOUDINARY_CLOUD_NAME: optional,
  CLOUDINARY_API_KEY: optional,
  CLOUDINARY_API_SECRET: optional,
  CLOUDINARY_FOLDER: z.string().regex(/^[\w-]+$/).default("ai-social"),

  // How often the worker looks for posts to publish.
  PUBLISH_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),

  // AI writing tools (Claude). Off unless ANTHROPIC_API_KEY is set.
  ANTHROPIC_API_KEY: optional,
  AI_MODEL: z.string().regex(/^claude-[w.-]+$/).default("claude-opus-5"),
  /** Requests that reach Claude, per workspace per UTC day. */
  AI_DAILY_REQUESTS_PER_WORKSPACE: z.coerce.number().int().min(0).default(50),
  /** Estimated spend across all workspaces per UTC day, in US dollars. AI pauses when it's reached. */
  AI_DAILY_SPEND_CAP_USD: z.coerce.number().min(0).default(5),
  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** How many times the SDK retries rate-limited or failed calls. */
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
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

let tokenKeys;
try {
  tokenKeys = parseKeyRing(e.TOKEN_ENCRYPTION_KEYS, e.TOKEN_ENCRYPTION_KEY);
} catch (err) {
  throw new Error(`Invalid environment configuration:\n  ${(err as Error).message}`);
}

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
  tokenKeys,
  instagram:
    e.INSTAGRAM_APP_ID && e.INSTAGRAM_APP_SECRET && e.INSTAGRAM_REDIRECT_URI
      ? {
          appId: e.INSTAGRAM_APP_ID,
          appSecret: e.INSTAGRAM_APP_SECRET,
          redirectUri: e.INSTAGRAM_REDIRECT_URI,
          graphVersion: e.INSTAGRAM_GRAPH_VERSION,
        }
      : undefined,
  facebook:
    e.FACEBOOK_APP_ID && e.FACEBOOK_APP_SECRET && e.FACEBOOK_REDIRECT_URI
      ? {
          appId: e.FACEBOOK_APP_ID,
          appSecret: e.FACEBOOK_APP_SECRET,
          redirectUri: e.FACEBOOK_REDIRECT_URI,
          configId: e.FACEBOOK_CONFIG_ID,
          graphVersion: e.FACEBOOK_GRAPH_VERSION,
        }
      : undefined,
  cloudinary:
    e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET
      ? {
          cloudName: e.CLOUDINARY_CLOUD_NAME,
          apiKey: e.CLOUDINARY_API_KEY,
          apiSecret: e.CLOUDINARY_API_SECRET,
          folder: e.CLOUDINARY_FOLDER,
        }
      : undefined,
  publishPollIntervalMs: e.PUBLISH_POLL_INTERVAL_MS,
  ai: {
    apiKey: e.ANTHROPIC_API_KEY,
    model: e.AI_MODEL,
    dailyRequestsPerWorkspace: e.AI_DAILY_REQUESTS_PER_WORKSPACE,
    dailySpendCapMicros: Math.round(e.AI_DAILY_SPEND_CAP_USD * 1_000_000),
    requestsPerMinute: e.AI_REQUESTS_PER_MINUTE,
    maxRetries: e.AI_MAX_RETRIES,
  },
};
