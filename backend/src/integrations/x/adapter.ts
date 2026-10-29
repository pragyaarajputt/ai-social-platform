import { env } from "../../config/env.js";
import type { PlatformAdapter, TokenSet } from "../types.js";
import { PlatformApiError } from "../types.js";
import { xCapabilities } from "./capabilities.js";
import * as x from "./client.js";
import * as publisher from "./publisher.js";

function app(): x.XAppConfig {
  if (!env.x) throw new PlatformApiError("X", "UNAVAILABLE", "X is not configured on this server");
  return env.x;
}

const toTokenSet = (t: x.XTokens): TokenSet => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  expiresAt: new Date(Date.now() + t.expiresInSeconds * 1000),
  scopes: t.scopes,
});

export const xAdapter: PlatformAdapter = {
  platform: "X",
  capabilities: xCapabilities,
  usesPkce: true,

  isConfigured: () => env.x !== undefined,

  getAuthorizationUrl(state, pkce) {
    if (!pkce) throw new PlatformApiError("X", "BAD_REQUEST", "X sign-in needs a PKCE code challenge");
    return x.buildAuthorizationUrl(app(), state, pkce.codeChallenge);
  },

  // The user who signs in; their own account is the one account.
  async connect(code, pkce) {
    if (!pkce) throw new PlatformApiError("X", "BAD_REQUEST", "X sign-in needs the PKCE code verifier");
    const tokens = toTokenSet(await x.exchangeCode(app(), code, pkce.codeVerifier));
    const me = await x.getMe(tokens.accessToken);
    return [{ profile: { externalId: me.id, accountType: "USER", username: me.username, name: me.name, avatarUrl: me.profileImageUrl }, tokens }];
  },

  // Access tokens last 2 hours; the refresh token (offline.access) renews them without the user.
  canRefresh: ({ hasRefreshToken }) => hasRefreshToken,
  refreshTokenOutlivesAccessToken: true,

  async refreshToken(token) {
    if (!token.refreshToken) throw new PlatformApiError("X", "INVALID_TOKEN", "X access can't be renewed without reconnecting");
    const refreshed = toTokenSet(await x.refreshAccessToken(app(), token.refreshToken));
    // X replaces the refresh token on every refresh; keep the old one only if none came back.
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? token.refreshToken };
  },

  async checkAccount(ctx) {
    const me = await x.getMe(ctx.accessToken);
    if (me.id !== ctx.accountExternalId) {
      throw new PlatformApiError("X", "INVALID_TOKEN", "The stored access belongs to a different X account");
    }
    return { username: me.username, name: me.name, avatarUrl: me.profileImageUrl };
  },

  chooseFormat: publisher.chooseFormat,
  validatePost: publisher.validatePost,
  publish: publisher.publish,
  // No insights: X bills every read, and post metrics need a paid plan's endpoints.
};
