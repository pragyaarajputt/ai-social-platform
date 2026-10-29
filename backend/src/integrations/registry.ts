import type { SocialPlatform } from "../generated/prisma/enums.js";
import { AppError } from "../utils/AppError.js";
import { blueskyAdapter } from "./bluesky/adapter.js";
import { facebookAdapter } from "./facebook/adapter.js";
import { instagramAdapter } from "./instagram/adapter.js";
import { linkedinAdapter } from "./linkedin/adapter.js";
import type { PlatformAdapter } from "./types.js";
import { xAdapter } from "./x/adapter.js";

const adapters: Partial<Record<SocialPlatform, PlatformAdapter>> = {
  INSTAGRAM: instagramAdapter,
  FACEBOOK: facebookAdapter,
  LINKEDIN: linkedinAdapter,
  X: xAdapter,
  BLUESKY: blueskyAdapter,
};

/** URL segment → platform, e.g. "instagram" → "INSTAGRAM". */
export function platformFromSlug(slug: string): SocialPlatform {
  const platform = slug.toUpperCase() as SocialPlatform;
  if (!adapters[platform]) throw new AppError(404, "PLATFORM_NOT_SUPPORTED", `"${slug}" is not a supported platform`);
  return platform;
}

export function getAdapter(platform: SocialPlatform): PlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) throw new AppError(404, "PLATFORM_NOT_SUPPORTED", `${platform} is not supported yet`);
  return adapter;
}

/** Platforms we can read post and account numbers from (not LinkedIn profiles, for example). */
export function platformsWithAnalytics(): SocialPlatform[] {
  return Object.values(adapters)
    .filter((a) => a.insights)
    .map((a) => a.platform);
}

export function listPlatforms() {
  return Object.values(adapters).map((a) => ({
    platform: a.platform,
    displayName: a.capabilities.displayName,
    configured: a.isConfigured(),
    connectMethod: a.connectMethod ?? "oauth",
  }));
}
