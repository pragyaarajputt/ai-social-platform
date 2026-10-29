import { env } from "../../config/env.js";
import type { ConnectedAccountGrant, PlatformAdapter, TokenSet } from "../types.js";
import { PlatformApiError } from "../types.js";
import { blueskyCapabilities } from "./capabilities.js";
import * as bsky from "./client.js";
import * as publisher from "./publisher.js";

/** Marks tokens that came from an app-password sign-in (Bluesky has no OAuth scopes for these). */
const SCOPES = ["app_password"];

const toTokenSet = (s: bsky.BlueskySession): TokenSet => ({
  accessToken: s.accessJwt,
  refreshToken: s.refreshJwt,
  // Session tokens are short-lived (a couple of hours); their exp claim says exactly.
  expiresAt: bsky.jwtExpiry(s.accessJwt) ?? new Date(Date.now() + 3_600_000),
  scopes: SCOPES,
});

async function grantFor(session: bsky.BlueskySession): Promise<ConnectedAccountGrant[]> {
  // The public profile has the display name and picture; the session alone only has the handle.
  const profile = await bsky.getProfile(session.did).catch(() => null);
  return [
    {
      profile: { externalId: session.did, accountType: "USER", username: session.handle, name: profile?.displayName, avatarUrl: profile?.avatar },
      tokens: toTokenSet(session),
    },
  ];
}

export const blueskyAdapter: PlatformAdapter = {
  platform: "BLUESKY",
  capabilities: blueskyCapabilities,
  connectMethod: "app_password",

  // Nothing to register: any Bluesky account can sign in with an app password.
  isConfigured: () => true,

  getAuthorizationUrl() {
    throw new PlatformApiError("BLUESKY", "BAD_REQUEST", "Bluesky connects with an app password, not a redirect");
  },
  async connect() {
    throw new PlatformApiError("BLUESKY", "BAD_REQUEST", "Bluesky connects with an app password, not a redirect");
  },

  async connectWithAppPassword(identifier, appPassword) {
    // People often type their handle with the @ in front.
    const id = identifier.trim().replace(/^@/, "");
    // Sign in where the account lives when that's known from the handle (not an email), so accounts on
    // other servers work too.
    const did = id.includes("@") ? null : await bsky.resolveHandle(id.toLowerCase()).catch(() => null);
    const service = did ? await bsky.resolvePds(did).catch(() => env.bluesky.service) : env.bluesky.service;
    return grantFor(await bsky.createSession(service, id, appPassword));
  },

  // The refresh token renews the session without the user, for months, even after access has expired.
  canRefresh: ({ hasRefreshToken }) => hasRefreshToken,
  refreshTokenOutlivesAccessToken: true,

  async refreshToken(token, account) {
    if (!token.refreshToken) throw new PlatformApiError("BLUESKY", "INVALID_TOKEN", "Bluesky access can't be renewed without reconnecting");
    const pds = await bsky.resolvePds(account.externalId);
    return toTokenSet(await bsky.refreshSession(pds, token.refreshToken));
  },

  async checkAccount(ctx) {
    const pds = await bsky.resolvePds(ctx.accountExternalId);
    const session = await bsky.getSession(pds, ctx.accessToken);
    if (session.did !== ctx.accountExternalId) {
      throw new PlatformApiError("BLUESKY", "INVALID_TOKEN", "The stored access belongs to a different Bluesky account");
    }
    const profile = await bsky.getProfile(session.did).catch(() => null);
    return { username: session.handle, name: profile?.displayName, avatarUrl: profile?.avatar };
  },

  chooseFormat: publisher.chooseFormat,
  validatePost: publisher.validatePost,
  publish: publisher.publish,
};
