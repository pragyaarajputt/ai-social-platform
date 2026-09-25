import { env } from "../../config/env.js";
import type { PlatformAdapter, TokenSet } from "../types.js";
import { PlatformApiError } from "../types.js";
import { instagramCapabilities } from "./capabilities.js";
import * as ig from "./client.js";
import * as publisher from "./publisher.js";

function app(): ig.InstagramAppConfig {
  if (!env.instagram) throw new PlatformApiError("INSTAGRAM", "UNAVAILABLE", "Instagram is not configured on this server");
  return env.instagram;
}

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000);

export const instagramAdapter: PlatformAdapter = {
  platform: "INSTAGRAM",
  capabilities: instagramCapabilities,

  isConfigured: () => env.instagram !== undefined,

  getAuthorizationUrl: (state) => ig.buildAuthorizationUrl(app(), state),

  async exchangeCode(code): Promise<TokenSet> {
    const short = await ig.exchangeCodeForShortLivedToken(app(), code);
    const long = await ig.exchangeForLongLivedToken(app(), short.accessToken);
    return {
      accessToken: long.accessToken,
      expiresAt: expiresAt(long.expiresInSeconds),
      scopes: short.permissions.length ? short.permissions : ig.INSTAGRAM_SCOPES,
    };
  },

  async fetchProfile(accessToken) {
    const p = await ig.getProfile(app(), accessToken);
    return {
      externalId: p.user_id,
      appScopedId: p.id,
      // Stored upper-case: "Business" → "BUSINESS", "Media_Creator" → "MEDIA_CREATOR".
      accountType: (p.account_type ?? "UNKNOWN").toUpperCase(),
      username: p.username,
      name: p.name,
      avatarUrl: p.profile_picture_url,
    };
  },

  // Instagram long-lived tokens are refreshed by exchanging the token itself; there is no refresh token.
  async refreshToken(token) {
    const refreshed = await ig.refreshLongLivedToken(token.accessToken);
    return { accessToken: refreshed.accessToken, expiresAt: expiresAt(refreshed.expiresInSeconds), scopes: token.scopes };
  },

  // A long-lived token can only be refreshed once it is at least 24 hours old.
  refreshableAfter: (lastRefreshedAt) => new Date(lastRefreshedAt.getTime() + 24 * 3_600_000),

  chooseFormat: publisher.chooseFormat,
  validatePost: publisher.validatePost,
  publish: (ctx) => publisher.publish(app(), ctx),
};
