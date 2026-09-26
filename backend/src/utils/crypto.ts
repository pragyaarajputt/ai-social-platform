import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, URL-safe. Used for refresh, verification and reset tokens. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * PKCE (RFC 7636): a random code_verifier kept on our server, and its S256 code_challenge sent in the
 * consent URL. The platform only hands out tokens to whoever presents the verifier, so an intercepted
 * authorization code is useless on its own.
 */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url"); // 43 characters, within the 43–128 allowed
  return { codeVerifier, codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url") };
}

/** Tokens are stored only as SHA-256 hashes, so a database leak doesn't expose usable tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
