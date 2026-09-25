import type { SocialPlatform } from "../generated/prisma/enums.js";

/** What a platform accepts. Read by validation now, and by the composer and AI optimizer later. */
export interface PlatformCapabilities {
  platform: SocialPlatform;
  displayName: string;
  captionMaxLength: number;
  hashtagMax?: number;
  mentionMax?: number;
  image?: { formats: string[]; maxBytes: number; minAspectRatio: number; maxAspectRatio: number };
  video?: { formats: string[]; maxBytes: number; minSeconds: number; maxSeconds: number };
  carouselMaxItems?: number;
  /** Posts that can be published through the API per rolling 24 hours, per account. */
  publishLimitPer24h?: number;
  /** Which account types can be connected, as the platform names them. */
  supportedAccountTypes: string[];
}

/** The platform account a user authorized, as returned by the adapter. */
export interface ConnectedProfile {
  externalId: string;
  appScopedId?: string;
  accountType: string;
  username?: string;
  name?: string;
  avatarUrl?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

/**
 * One implementation per platform. The rest of the app only talks to this interface, so adding a
 * platform means writing one adapter. Publishing methods arrive in the next phase.
 */
export interface PlatformAdapter {
  platform: SocialPlatform;
  capabilities: PlatformCapabilities;
  /** False when the platform's app credentials aren't configured on this server. */
  isConfigured(): boolean;
  getAuthorizationUrl(state: string): string;
  /** Exchanges the callback code for the longest-lived token the platform offers. */
  exchangeCode(code: string): Promise<TokenSet>;
  fetchProfile(accessToken: string): Promise<ConnectedProfile>;
  refreshToken(token: TokenSet): Promise<TokenSet>;
  /** Earliest moment a token may be refreshed, if the platform restricts it. */
  refreshableAfter?(lastRefreshedAt: Date): Date;
}

/** An error from a platform API, with a code we can act on. */
export class PlatformApiError extends Error {
  constructor(
    public readonly platform: SocialPlatform,
    public readonly code: "INVALID_TOKEN" | "PERMISSION_DENIED" | "RATE_LIMITED" | "BAD_REQUEST" | "UNAVAILABLE",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}
