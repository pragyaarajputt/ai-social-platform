// A fake Bluesky: the sign-in service (bsky.social), the account's own server (a PDS at
// pds.example.test, found through its DID document on plc.directory), and the public API. Used through
// the fetch mock in support.ts. The account's app password is BSKY_APP_PASSWORD.

export const BSKY_DID = "did:plc:pragyatest0000000000001";
export const BSKY_HANDLE = "pragya.bsky.social";
export const BSKY_APP_PASSWORD = "abcd-efgh-ijkl-mnop";
const PDS = "https://pds.example.test";

/** A JWT-shaped token whose exp is `secondsFromNow` ahead (the signature isn't checked by clients). */
export function fakeJwt(name: string, secondsFromNow: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ES256K", typ: "at+jwt" })}.${part({ sub: BSKY_DID, name, exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.c2ln`;
}

export interface FakeBluesky {
  /** Access tokens the PDS accepts, and the one refresh token it currently accepts. */
  accessTokens: Set<string>;
  refreshToken: string | null;
  refreshes: number;
  /** Handles other accounts have, for @mentions. */
  handles: Map<string, string>;
  blobs: Map<string, { bytes: Buffer; mimeType: string }>;
  posts: Map<string, { rkey: string; cid: string; record: Record<string, any>; token: string }>;
  /** Answer the next calls whose "METHOD path" contains `match` (with `afterPosts`: once that many posts exist); `thenCreate` creates the post first. */
  failures: { match: string; status: number; body: unknown; afterPosts?: number; thenCreate?: boolean }[];
  calls: string[];
}

export let bf: FakeBluesky;
export let firstAccessToken: string;

export function resetBluesky() {
  firstAccessToken = fakeJwt("access-1", 2 * 3600);
  bf = {
    accessTokens: new Set([firstAccessToken]),
    refreshToken: "bsky-refresh-1",
    refreshes: 0,
    handles: new Map([[BSKY_HANDLE, BSKY_DID], ["friend.bsky.social", "did:plc:friend0000000000000001"]]),
    blobs: new Map(),
    posts: new Map(),
    failures: [],
    calls: [],
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const xrpcError = (status: number, error: string, message: string) => json(status, { error, message });

const didDoc = { id: BSKY_DID, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] };

function session(access: string, refresh: string) {
  return { did: BSKY_DID, handle: BSKY_HANDLE, accessJwt: access, refreshJwt: refresh, didDoc, active: true };
}

let seq = 0;

function createPost(body: Record<string, any>, token: string) {
  const cid = `bafyrei${String(++seq).padStart(6, "0")}`;
  bf.posts.set(body.rkey, { rkey: body.rkey, cid, record: body.record, token });
  return { uri: `at://${BSKY_DID}/app.bsky.feed.post/${body.rkey}`, cid };
}

/** Handles a request if it's for Bluesky; returns null otherwise. */
export async function handleBluesky(url: URL, init?: RequestInit): Promise<Response | null> {
  const hosts = ["bsky.social", "pds.example.test", "plc.directory", "public.api.bsky.app"];
  if (!hosts.includes(url.host)) return null;
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const nsid = url.pathname.replace(/^\/xrpc\//, "");
  bf.calls.push(`${method} ${url.host}${url.pathname}`);

  const failure = bf.failures.findIndex((f) => `${method} ${url.pathname}${url.search}`.includes(f.match) && bf.posts.size >= (f.afterPosts ?? 0));
  if (failure >= 0) {
    const f = bf.failures.splice(failure, 1)[0]!;
    if (f.thenCreate) createPost(JSON.parse(String(init!.body)), headers.get("authorization")!.slice(7));
    return json(f.status, f.body);
  }

  if (url.host === "plc.directory") {
    return decodeURIComponent(url.pathname.slice(1)) === BSKY_DID ? json(200, didDoc) : json(404, { message: "DID not registered" });
  }

  if (url.host === "public.api.bsky.app") {
    if (nsid === "com.atproto.identity.resolveHandle") {
      const did = bf.handles.get(url.searchParams.get("handle") ?? "");
      return did ? json(200, { did }) : xrpcError(400, "InvalidRequest", "Unable to resolve handle");
    }
    if (nsid === "app.bsky.actor.getProfile" && url.searchParams.get("actor") === BSKY_DID) {
      return json(200, { did: BSKY_DID, handle: BSKY_HANDLE, displayName: "Pragya Rajput", avatar: "https://cdn.bsky.example/avatar.jpg" });
    }
    return xrpcError(400, "InvalidRequest", "Profile not found");
  }

  // Signing in works on the sign-in service and on the account's own server.
  if (nsid === "com.atproto.server.createSession" && method === "POST") {
    const body = JSON.parse(String(init!.body)) as Record<string, string>;
    const known = body.identifier === BSKY_HANDLE || body.identifier === "pragya@example.test";
    if (!known || body.password !== BSKY_APP_PASSWORD) return xrpcError(401, "AuthenticationRequired", "Invalid identifier or password");
    return json(200, session(firstAccessToken, bf.refreshToken!));
  }

  if (url.host !== "pds.example.test") throw new Error(`Unexpected Bluesky call: ${method} ${url.host}${url.pathname}`);

  if (nsid === "com.atproto.server.refreshSession" && method === "POST") {
    const presented = headers.get("authorization")?.replace(/^Bearer /, "");
    if (!bf.refreshToken || presented !== bf.refreshToken) return xrpcError(400, "ExpiredToken", "Token has been revoked");
    bf.refreshes++;
    const access = fakeJwt(`access-${bf.refreshes + 1}`, 2 * 3600);
    bf.accessTokens.add(access);
    bf.refreshToken = `bsky-refresh-${bf.refreshes + 1}`;
    return json(200, session(access, bf.refreshToken));
  }

  // Reading a record needs no sign-in.
  if (nsid === "com.atproto.repo.getRecord" && method === "GET") {
    const post = bf.posts.get(url.searchParams.get("rkey") ?? "");
    if (url.searchParams.get("repo") !== BSKY_DID || !post) return xrpcError(400, "RecordNotFound", "Could not locate record");
    return json(200, { uri: `at://${BSKY_DID}/app.bsky.feed.post/${post.rkey}`, cid: post.cid, value: post.record });
  }

  const token = headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || !bf.accessTokens.has(token)) return xrpcError(400, "ExpiredToken", "Token has expired");

  if (nsid === "com.atproto.server.getSession" && method === "GET") return json(200, { did: BSKY_DID, handle: BSKY_HANDLE });

  if (nsid === "com.atproto.repo.uploadBlob" && method === "POST") {
    const bytes = Buffer.from(init!.body as Uint8Array);
    const link = `bafkrei${String(++seq).padStart(6, "0")}`;
    const mimeType = headers.get("content-type") ?? "application/octet-stream";
    bf.blobs.set(link, { bytes, mimeType });
    return json(200, { blob: { $type: "blob", ref: { $link: link }, mimeType, size: bytes.length } });
  }

  if (nsid === "com.atproto.repo.createRecord" && method === "POST") {
    const body = JSON.parse(String(init!.body)) as Record<string, any>;
    const r = body.record;
    if (body.repo !== BSKY_DID || body.collection !== "app.bsky.feed.post" || r?.$type !== "app.bsky.feed.post" || typeof r.createdAt !== "string") {
      return xrpcError(400, "InvalidRequest", "Invalid record");
    }
    if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(body.rkey)) return xrpcError(400, "InvalidRequest", "Invalid record key");
    if (bf.posts.has(body.rkey)) return xrpcError(400, "InvalidRequest", "Record already exists");
    if ([...new Intl.Segmenter().segment(r.text)].length > 300) return xrpcError(400, "InvalidRequest", "Record/text must not be longer than 300 graphemes");
    for (const image of r.embed?.images ?? []) {
      if (!bf.blobs.has(image.image?.ref?.$link) || typeof image.alt !== "string") return xrpcError(400, "InvalidRequest", "Could not find blob");
    }
    for (const ref of [r.reply?.root, r.reply?.parent].filter(Boolean)) {
      const rkey = String(ref.uri).split("/").pop()!;
      if (bf.posts.get(rkey)?.cid !== ref.cid) return xrpcError(400, "InvalidRequest", "Reply reference doesn't match");
    }
    return json(200, createPost(body, token));
  }

  throw new Error(`Unexpected Bluesky call: ${method} ${url.host}${url.pathname}`);
}
