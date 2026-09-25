import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignedRequestPayload {
  user_id: string;
  algorithm: string;
  issued_at?: number;
}

/**
 * Verifies a Meta `signed_request` ("<signature>.<payload>", both base64url; the signature is an
 * HMAC-SHA256 of the payload part using the app secret). Meta sends these to deauthorize and
 * data-deletion callbacks. Returns null if the signature or payload is invalid.
 */
export function parseSignedRequest(signedRequest: unknown, appSecret: string): SignedRequestPayload | null {
  if (typeof signedRequest !== "string") return null;
  const [encodedSig, encodedPayload, extra] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload || extra !== undefined) return null;

  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  const actual = Buffer.from(encodedSig, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (String(payload.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    if (payload.user_id === undefined || payload.user_id === null) return null;
    return {
      user_id: String(payload.user_id),
      algorithm: String(payload.algorithm),
      issued_at: typeof payload.issued_at === "number" ? payload.issued_at : undefined,
    };
  } catch {
    return null;
  }
}
