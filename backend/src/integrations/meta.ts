import type { SocialPlatform } from "../generated/prisma/enums.js";
import { PlatformApiError } from "./types.js";

// HTTP and error handling shared by Meta's APIs (Instagram and Facebook use the same Graph API
// conventions). URLs can contain access tokens: never log them.

export async function metaRequest(platform: SocialPlatform, url: string, init?: RequestInit): Promise<unknown> {
  const name = platform === "FACEBOOK" ? "Facebook" : "Instagram";
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new PlatformApiError(platform, "UNAVAILABLE", `Couldn't reach ${name}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toMetaError(platform, res.status, body);
  // Facebook reports some failures with HTTP 200 and { error } (e.g. batch-style upload endpoints).
  if (body && typeof body === "object" && "error" in body && (body as { error?: unknown }).error) throw toMetaError(platform, 400, body);
  return body;
}

/**
 * Meta returns errors either as Graph API errors ({ error: { code, message, ... } }) or, from
 * Instagram's OAuth endpoint, as { error_type, code, error_message }.
 * Codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function toMetaError(platform: SocialPlatform, status: number, body: unknown): PlatformApiError {
  const b = (body ?? {}) as Record<string, unknown>;
  const graph = (b.error ?? {}) as Record<string, unknown>;
  const code = Number(graph.code ?? b.code);
  const name = platform === "FACEBOOK" ? "Facebook" : "Instagram";
  const message = String(graph.error_user_msg ?? graph.message ?? b.error_message ?? `${name} returned HTTP ${status}`);
  const details = { status, code, type: graph.type ?? b.error_type, subcode: graph.error_subcode, trace: graph.fbtrace_id };

  if (code === 190 || code === 102 || status === 401) return new PlatformApiError(platform, "INVALID_TOKEN", message, details);
  if ([4, 17, 32, 613, 80001, 80004].includes(code) || status === 429) return new PlatformApiError(platform, "RATE_LIMITED", message, details);
  if (code === 10 || (code >= 200 && code < 300) || status === 403) return new PlatformApiError(platform, "PERMISSION_DENIED", message, details);
  if (status >= 500 || code === 1 || code === 2) return new PlatformApiError(platform, "UNAVAILABLE", message, details);
  return new PlatformApiError(platform, "BAD_REQUEST", message, details);
}

/** Many Meta responses wrap the object in { data: [ ... ] }. */
export function firstRecord(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.data) && b.data[0] && typeof b.data[0] === "object") return b.data[0] as Record<string, unknown>;
  return b;
}

export function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
