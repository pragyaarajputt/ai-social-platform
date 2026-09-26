import { env } from "../../config/env.js";
import type { ConnectedAccountGrant, PlatformAdapter } from "../types.js";
import { PlatformApiError } from "../types.js";
import { facebookCapabilities } from "./capabilities.js";
import * as fb from "./client.js";
import { facebookInsights } from "./insights.js";
import * as publisher from "./publisher.js";

function app(): fb.FacebookAppConfig {
  if (!env.facebook) throw new PlatformApiError("FACEBOOK", "UNAVAILABLE", "Facebook is not configured on this server");
  return env.facebook;
}

/** A Page can be posted to only by people with the CREATE_CONTENT task on it. */
const canPublish = (page: fb.FacebookPage) => page.tasks.includes("CREATE_CONTENT");

export const facebookAdapter: PlatformAdapter = {
  platform: "FACEBOOK",
  capabilities: facebookCapabilities,

  isConfigured: () => env.facebook !== undefined,

  getAuthorizationUrl: (state) => fb.buildAuthorizationUrl(app(), state),

  // One login can grant several Pages: each becomes its own account, with its own Page token.
  async connect(code): Promise<ConnectedAccountGrant[]> {
    const userToken = await fb.exchangeCode(app(), code);
    const [userId, scopes, pages] = await Promise.all([
      fb.getUserId(app(), userToken),
      fb.getGrantedPermissions(app(), userToken),
      fb.listPages(app(), userToken),
    ]);
    return pages.filter(canPublish).map((page) => ({
      profile: {
        externalId: page.id,
        // Meta's deauthorize and data-deletion callbacks identify the Facebook user, not the Page.
        appScopedId: userId,
        accountType: "PAGE",
        username: page.username ?? page.name,
        name: page.name,
        avatarUrl: page.pictureUrl,
      },
      // Page tokens from a long-lived user token don't expire.
      tokens: { accessToken: page.accessToken, scopes },
    }));
  },

  // Page tokens don't expire, so there's nothing to refresh. The worker never asks (no expiry date).
  refreshToken: async (token) => token,

  chooseFormat: publisher.chooseFormat,
  validatePost: publisher.validatePost,
  publish: (ctx) => publisher.publish(app(), ctx),
  insights: facebookInsights(app),
};
