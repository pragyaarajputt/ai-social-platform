import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, URL-safe. Used for refresh, verification and reset tokens. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are stored only as SHA-256 hashes, so a database leak doesn't expose usable tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
