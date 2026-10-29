import { optionalString } from "../meta.js";
import { PlatformApiError } from "../types.js";

// Bluesky through the AT Protocol's XRPC API, signed in with an app password (checked 2026-10-29):
// https://atproto.com/specs/xrpc, https://atproto.com/specs/did and the com.atproto lexicons at
// github.com/bluesky-social/atproto/tree/main/lexicons.
//
// Signing in (com.atproto.server.createSession) happens once, at connect: the app password is then
// thrown away and only the session's tokens are kept. The refresh token renews the session
// (com.atproto.server.refreshSession), returning a new refresh token each time. After sign-in every call
// goes to the account's own server (its PDS), found in its DID document: accounts can live on any server,
// not just bsky.social. All of this is free: the API has rate limits but no charges.

/** Where people sign in, unless they enter their own server. */
export const DEFAULT_SERVICE = "https://bsky.social";
/** Public, unauthenticated reads (profiles, handle lookups). */
const PUBLIC_API = "https://public.api.bsky.app";
const PLC_DIRECTORY = "https://plc.directory";

async function send(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new PlatformApiError("BLUESKY", "UNAVAILABLE", "Couldn't reach Bluesky");
  }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON (e.g. a proxy's error page).
  }
  if (!res.ok) throw toBlueskyError(res.status, body);
  return body;
}

const xrpc = (service: string, method: string, params?: Record<string, string>) =>
  `${service.replace(/\/+$/, "")}/xrpc/${method}${params ? `?${new URLSearchParams(params)}` : ""}`;

/** XRPC errors are { error, message }: https://atproto.com/specs/xrpc */
export function toBlueskyError(status: number, body: Record<string, unknown>): PlatformApiError {
  const name = optionalString(body.error);
  const message = optionalString(body.message) ?? name ?? `Bluesky returned HTTP ${status}`;
  const details = { status, error: name };
  if (status === 401 || name === "ExpiredToken" || name === "InvalidToken" || name === "AccountTakedown") {
    return new PlatformApiError("BLUESKY", "INVALID_TOKEN", message, details);
  }
  if (status === 403) return new PlatformApiError("BLUESKY", "PERMISSION_DENIED", message, details);
  if (status === 429) return new PlatformApiError("BLUESKY", "RATE_LIMITED", message, details);
  if (status >= 500) return new PlatformApiError("BLUESKY", "UNAVAILABLE", message, details);
  return new PlatformApiError("BLUESKY", "BAD_REQUEST", message, details);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface BlueskySession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** The account's own server, from the session's DID document when it came with one. */
  pds?: string;
}

function toSession(body: Record<string, unknown>): BlueskySession {
  const { did, handle, accessJwt, refreshJwt } = body;
  if (typeof did !== "string" || typeof handle !== "string" || typeof accessJwt !== "string" || typeof refreshJwt !== "string") {
    throw unexpected("the session is missing fields");
  }
  return { did, handle, accessJwt, refreshJwt, pds: pdsFromDidDoc(body.didDoc) };
}

/** Signs in with a handle (or email) and an app password. */
export async function createSession(service: string, identifier: string, password: string): Promise<BlueskySession> {
  try {
    return toSession(
      await send(xrpc(service, "com.atproto.server.createSession"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      }),
    );
  } catch (err) {
    // A wrong handle or password is the sign-in failing, not a stored token going bad.
    if (err instanceof PlatformApiError && err.code === "INVALID_TOKEN") throw new PlatformApiError("BLUESKY", "BAD_REQUEST", err.message, err.details);
    throw err;
  }
}

/** Renews the session with the refresh token; the old refresh token stops working. */
export async function refreshSession(pds: string, refreshJwt: string): Promise<BlueskySession> {
  try {
    return toSession(await send(xrpc(pds, "com.atproto.server.refreshSession"), { method: "POST", headers: { Authorization: `Bearer ${refreshJwt}` } }));
  } catch (err) {
    // A refresh token that's unknown, used or expired needs a reconnect.
    if (err instanceof PlatformApiError && err.code === "BAD_REQUEST") throw new PlatformApiError("BLUESKY", "INVALID_TOKEN", err.message, err.details);
    throw err;
  }
}

/** When a session token expires: its `exp` claim. Tokens are otherwise treated as opaque. */
export function jwtExpiry(jwt: string): Date | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** Who the access token belongs to; fails if the session is no longer valid. */
export async function getSession(pds: string, accessJwt: string): Promise<{ did: string; handle?: string }> {
  const body = await send(xrpc(pds, "com.atproto.server.getSession"), { headers: { Authorization: `Bearer ${accessJwt}` } });
  if (typeof body.did !== "string") throw unexpected("session has no DID");
  return { did: body.did, handle: optionalString(body.handle) };
}

// ─── Identity ───────────────────────────────────────────────────────────────

/** The PDS in a DID document: the service with id ending "#atproto_pds". https://atproto.com/specs/did */
function pdsFromDidDoc(doc: unknown): string | undefined {
  const services = (doc as { service?: unknown } | null)?.service;
  if (!Array.isArray(services)) return undefined;
  for (const s of services as Record<string, unknown>[]) {
    if (typeof s.id === "string" && s.id.endsWith("#atproto_pds") && s.type === "AtprotoPersonalDataServer" && typeof s.serviceEndpoint === "string") {
      if (s.serviceEndpoint.startsWith("https://")) return s.serviceEndpoint;
    }
  }
  return undefined;
}

const pdsCache = new Map<string, { pds: string; until: number }>();
const PDS_CACHE_MS = 60 * 60_000;

/** The account's server, from its DID document (did:plc from the PLC directory, did:web from the domain). Cached for an hour. */
export async function resolvePds(did: string): Promise<string> {
  const cached = pdsCache.get(did);
  if (cached && cached.until > Date.now()) return cached.pds;
  let url: string;
  if (did.startsWith("did:plc:")) url = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
  else if (/^did:web:[a-z0-9.-]+$/i.test(did)) url = `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  else throw new PlatformApiError("BLUESKY", "BAD_REQUEST", `Unsupported DID: ${did}`);
  const pds = pdsFromDidDoc(await send(url));
  if (!pds) throw unexpected("the account's DID document names no server");
  pdsCache.set(did, { pds, until: Date.now() + PDS_CACHE_MS });
  return pds;
}

/** A handle's DID, or null if no account has it. */
export async function resolveHandle(handle: string): Promise<string | null> {
  try {
    const body = await send(xrpc(PUBLIC_API, "com.atproto.identity.resolveHandle", { handle }));
    return optionalString(body.did) ?? null;
  } catch (err) {
    if (err instanceof PlatformApiError && err.code === "BAD_REQUEST") return null;
    throw err;
  }
}

export interface BlueskyProfile {
  did: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

/** A public profile, from the public API. */
export async function getProfile(actor: string): Promise<BlueskyProfile> {
  const body = await send(xrpc(PUBLIC_API, "app.bsky.actor.getProfile", { actor }));
  if (typeof body.did !== "string") throw unexpected("profile has no DID");
  return { did: body.did, handle: optionalString(body.handle), displayName: optionalString(body.displayName), avatar: optionalString(body.avatar) };
}

// ─── Records ────────────────────────────────────────────────────────────────

export interface BlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/** Uploads an image; the returned blob is referenced from the post. Unreferenced blobs are deleted. */
export async function uploadBlob(pds: string, token: string, bytes: Uint8Array<ArrayBuffer>, mimeType: string): Promise<BlobRef> {
  const body = await send(xrpc(pds, "com.atproto.repo.uploadBlob"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
    body: bytes,
  });
  const blob = body.blob as BlobRef | undefined;
  if (!blob?.ref?.$link) throw unexpected("blob upload returned no reference");
  return blob;
}

export interface StrongRef {
  uri: string;
  cid: string;
}

export const POST_COLLECTION = "app.bsky.feed.post";

/** Creates a post with the record key we chose, so we can later ask whether it exists. */
export async function createPost(pds: string, token: string, repo: string, rkey: string, record: Record<string, unknown>): Promise<StrongRef> {
  const body = await send(xrpc(pds, "com.atproto.repo.createRecord"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repo, collection: POST_COLLECTION, rkey, record: { $type: POST_COLLECTION, ...record } }),
  });
  if (typeof body.uri !== "string" || typeof body.cid !== "string") throw unexpected("post creation returned no URI");
  return { uri: body.uri, cid: body.cid };
}

/** The post with this record key, or null if it doesn't exist. Free and unauthenticated. */
export async function getPost(pds: string, repo: string, rkey: string): Promise<StrongRef | null> {
  try {
    const body = await send(xrpc(pds, "com.atproto.repo.getRecord", { repo, collection: POST_COLLECTION, rkey }));
    if (typeof body.uri !== "string" || typeof body.cid !== "string") throw unexpected("record has no CID");
    return { uri: body.uri, cid: body.cid };
  } catch (err) {
    if (err instanceof PlatformApiError && (err.details as { error?: string } | undefined)?.error === "RecordNotFound") return null;
    throw err;
  }
}

/** The post's page on bsky.app. */
export const postUrl = (did: string, rkey: string) => `https://bsky.app/profile/${did}/post/${rkey}`;

// ─── Record keys ────────────────────────────────────────────────────────────

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
let lastTidMicros = 0;

/**
 * A new TID record key (https://atproto.com/specs/tid): 13 base32-sortable characters encoding 53 bits
 * of microseconds since the epoch and a 10-bit clock ID. Never repeats within this process.
 */
export function newTid(now = Date.now()): string {
  let micros = now * 1000;
  if (micros <= lastTidMicros) micros = lastTidMicros + 1;
  lastTidMicros = micros;
  let n = (BigInt(micros) << 10n) | BigInt(Math.floor(Math.random() * 1024));
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = TID_ALPHABET[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

function unexpected(what: string): PlatformApiError {
  return new PlatformApiError("BLUESKY", "UNAVAILABLE", `Unexpected response from Bluesky: ${what}`);
}
