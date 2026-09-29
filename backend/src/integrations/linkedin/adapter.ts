import { env } from "../../config/env.js";
import type { PlatformAdapter, TokenSet } from "../types.js";
import { PlatformApiError } from "../types.js";
import { linkedinCapabilities } from "./capabilities.js";
import * as li from "./client.js";
import * as publisher from "./publisher.js";

function app(): li.LinkedInAppConfig {
  if (!env.linkedin) throw new PlatformApiError("LINKEDIN", "UNAVAILABLE", "LinkedIn is not configured on this server");
  return env.linkedin;
}

const toTokenSet = (t: li.LinkedInTokens): TokenSet => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  expiresAt: new Date(Date.now() + t.expiresInSeconds * 1000),
  scopes: t.scopes,
});

export const linkedinAdapter: PlatformAdapter = {
  platform: "LINKEDIN",
  capabilities: linkedinCapabilities,

  isConfigured: () => env.linkedin !== undefined,

  getAuthorizationUrl: (state) => li.buildAuthorizationUrl(app(), state),

  // The member who signs in; their personal profile is the one account.
  async connect(code) {
    const tokens = toTokenSet(await li.exchangeCode(app(), code));
    const p = await li.getProfile(tokens.accessToken);
    return [{ profile: { externalId: p.id, accountType: "PERSON", name: p.name, avatarUrl: p.pictureUrl }, tokens }];
  },

  // Access tokens last 60 days. Only apps LinkedIn has approved for programmatic refresh get refresh
  // tokens; everyone else reconnects (LinkedIn skips the consent screen while the member is signed in).
  canRefresh: ({ hasRefreshToken }) => hasRefreshToken,

  async refreshToken(token) {
    if (!token.refreshToken) throw new PlatformApiError("LINKEDIN", "INVALID_TOKEN", "LinkedIn access can't be renewed without reconnecting");
    const refreshed = toTokenSet(await li.refreshAccessToken(app(), token.refreshToken));
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? token.refreshToken, scopes: token.scopes };
  },

  async checkAccount(ctx) {
    const p = await li.getProfile(ctx.accessToken);
    if (p.id !== ctx.accountExternalId) {
      throw new PlatformApiError("LINKEDIN", "INVALID_TOKEN", "The stored access belongs to a different LinkedIn member");
    }
    return { name: p.name, avatarUrl: p.pictureUrl };
  },

  chooseFormat: publisher.chooseFormat,
  validatePost: publisher.validatePost,
  publish: (ctx) => publisher.publish(app(), ctx),
  // No insights: reading a member's post statistics is a restricted LinkedIn permission.
};
