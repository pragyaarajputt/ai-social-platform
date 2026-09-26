import { env } from "../../config/env.js";
import type { PlatformAdapter, TokenSet } from "../types.js";
import { PlatformApiError } from "../types.js";
import { instagramCapabilities } from "./capabilities.js";
import * as ig from "./client.js";
import { instagramInsights } from "./insights.js";
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

  // Instagram Login grants exactly one account: the one the user signed in with.
  async connect(code) {
    const short = await ig.exchangeCodeForShortLivedToken(app(), code);
    const long = await ig.exchangeForLongLivedToken(app(), short.accessToken);
    const tokens: TokenSet = {
      accessToken: long.accessToken,
      expiresAt: expiresAt(long.expiresInSeconds),
      scopes: short.permissions.length ? short.permissions : ig.INSTAGRAM_SCOPES,
    };
    const p = await ig.getProfile(app(), tokens.accessToken);
    const profile = {
      externalId: p.user_id,
      appScopedId: p.id,
      // Stored upper-case: "Business" → "BUSINESS", "Media_Creator" → "MEDIA_CREATOR".
      accountType: (p.account_type ?? "UNKNOWN").toUpperCase(),
      username: p.username,
      name: p.name,
      avatarUrl: p.profile_picture_url,
    };
    return [{ profile, tokens }];
  },

  // Instagram long-lived tokens are refreshed by exchanging the token itself; there is no refresh token.
  async refreshToken(token) {
    const refreshed = await ig.refreshLongLivedToken(token.accessToken);
    return { accessToken: refreshed.accessToken, expiresAt: expiresAt(refreshed.expiresInSeconds), scopes: token.scopes };
  },

  // A long-lived token can only be refreshed once it is at least 24 hours old.
  refreshableAfter: (lastRefreshedAt) => new Date(lastRefreshedAt.getTime() + 24 * 3_600_000),

  async checkAccount(ctx) {
    const p = await ig.getProfile(app(), ctx.accessToken);
    if (p.user_id !== ctx.accountExternalId) {
      throw new PlatformApiError("INSTAGRAM", "INVALID_TOKEN", "The stored access belongs to a different Instagram account");
    }
    return { username: p.username, name: p.name, avatarUrl: p.profile_picture_url };
  },

  chooseFormat: publisher.chooseFormat,
  validatePost: publisher.validatePost,
  publish: (ctx) => publisher.publish(app(), ctx),
  insights: instagramInsights(app),
};
