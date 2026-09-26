import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

// Social account tokens (and other OAuth secrets) are encrypted with AES-256-GCM before they are stored.
// Format: "<key version>:<iv>:<auth tag>:<ciphertext>", all base64url, e.g. "v1:...".
//
// Key rotation: put a new key first in TOKEN_ENCRYPTION_KEYS ("v2:<new>,v1:<old>"). New data is
// encrypted with it straight away, old data stays readable with the older keys, and the worker
// re-encrypts old data in the background (jobs/keyRotation.ts). Once `npm run tokens:key-status`
// shows nothing left on the old version, remove the old key.

// Read on each call (not captured once), so tests can swap the key ring to simulate a rotation.
const ring = () => env.tokenKeys;

export function encryptToken(plaintext: string): string {
  const { current, keys } = ring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(current)!, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [current, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

/** Throws if the value was tampered with or encrypted with an unknown key. */
export function decryptToken(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  const key = version ? ring().keys.get(version) : undefined;
  if (!key || !iv || !tag || !ciphertext) throw new Error("Unrecognized encrypted token format");

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** The key version a stored value was encrypted with, e.g. "v1". */
export const keyVersionOf = (stored: string) => stored.slice(0, stored.indexOf(":"));

export const currentKeyVersion = () => ring().current;
