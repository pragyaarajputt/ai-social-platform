import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

// Social account tokens are encrypted with AES-256-GCM before they are stored.
// Format: "v1:<iv>:<auth tag>:<ciphertext>", all base64url. The version prefix lets us rotate keys
// later: add a v2 key, encrypt new tokens with it, and keep v1 for decrypting old ones.

const VERSION = "v1";
const keys: Record<string, Buffer> = { v1: env.tokenEncryptionKey };

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys[VERSION]!, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

/** Throws if the value was tampered with or encrypted with an unknown key. */
export function decryptToken(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  const key = version ? keys[version] : undefined;
  if (!key || !iv || !tag || !ciphertext) throw new Error("Unrecognized encrypted token format");

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
