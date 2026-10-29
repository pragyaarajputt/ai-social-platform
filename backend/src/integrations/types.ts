import type { PostFormat, SocialPlatform } from "../generated/prisma/enums.js";

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

/** One account a user authorized, with its own tokens. A single login can grant several (e.g. Facebook Pages). */
export interface ConnectedAccountGrant {
  profile: ConnectedProfile;
  tokens: TokenSet;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface PublishMedia {
  type: "IMAGE" | "VIDEO";
  /** Public URL the platform downloads from. */
  url: string;
  format: string;
  bytes: number;
  width: number;
  height: number;
  durationSec?: number | null;
}

/** What choosing a format looks at: the media type, and for videos their shape and length. */
export type FormatMedia = Pick<PublishMedia, "type" | "width" | "height" | "durationSec">;

export interface PublishRequest {
  format: PostFormat;
  caption: string;
  media: PublishMedia[];
}

export type PublishResult =
  | { kind: "published"; externalPostId?: string; permalink?: string }
  /** The platform is still processing media: call publish() again after retryAfterMs. */
  | { kind: "waiting"; retryAfterMs: number };

export interface PublishContext {
  accessToken: string;
  /** The account's ID on the platform. */
  accountExternalId: string;
  request: PublishRequest;
  /** Progress saved by earlier calls (e.g. container IDs). Empty on the first call. */
  state: Record<string, unknown>;
  /** Persists progress immediately, so a crash never makes a retry repeat a step. */
  saveState(state: Record<string, unknown>): Promise<void>;
  /** When publishing of this target first started; used to recover a post after a crash. */
  startedAt: Date;
}

// ─── Analytics ──────────────────────────────────────────────────────────────

/** A post's numbers. Metrics a platform doesn't report for the format are left out. */
export interface PostMetrics {
  views?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  totalInteractions?: number;
  profileVisits?: number;
  follows?: number;
  avgWatchTimeMs?: number;
}

/** An account's numbers for one day. */
export interface AccountDayMetrics {
  reach?: number;
  views?: number;
  accountsEngaged?: number;
  totalInteractions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  profileLinksTaps?: number;
  follows?: number;
  unfollows?: number;
}

export interface InsightsContext {
  accessToken: string;
  accountExternalId: string;
}

export interface InsightsProvider {
  /** The permission the account must grant for insights. */
  requiredScope: string;
  postMetrics(ctx: InsightsContext, externalPostId: string, format: PostFormat): Promise<PostMetrics>;
  /** Numbers for the UTC day starting at `dayStart`. */
  accountDay(ctx: InsightsContext, dayStart: Date): Promise<AccountDayMetrics>;
  followersCount(ctx: InsightsContext): Promise<number | undefined>;
  /** Average followers online per UTC weekday (0 = Sunday) × hour; null when there's no data. */
  onlineFollowers(ctx: InsightsContext): Promise<number[][] | null>;
}

/**
 * One implementation per platform. The rest of the app only talks to this interface, so adding a
 * platform means writing one adapter.
 */
export interface PlatformAdapter {
  platform: SocialPlatform;
  capabilities: PlatformCapabilities;
  /** False when the platform's app credentials aren't configured on this server. */
  isConfigured(): boolean;
  /** The platform requires PKCE: the connect flow then passes a code challenge and later the verifier. */
  usesPkce?: boolean;
  getAuthorizationUrl(state: string, pkce?: { codeChallenge: string }): string;
  /**
   * Finishes the OAuth flow: exchanges the callback code for the longest-lived tokens the platform
   * offers and returns every account the user granted (one for Instagram; each chosen Page for Facebook).
   */
  connect(code: string, pkce?: { codeVerifier: string }): Promise<ConnectedAccountGrant[]>;
  refreshToken(token: TokenSet): Promise<TokenSet>;
  /** Earliest moment a token may be refreshed, if the platform restricts it. */
  refreshableAfter?(lastRefreshedAt: Date): Date;
  /**
   * Whether a token can be renewed without the user (absent: always). When it can't, the worker leaves
   * it alone until it expires, and the account asks for a reconnect before then.
   */
  canRefresh?(token: { hasRefreshToken: boolean }): boolean;
  /**
   * The refresh token keeps working after the access token expires (X: access lasts 2 hours, the
   * refresh token much longer), so an expired access token is refreshed instead of asking for a
   * reconnect, and publishing refreshes it first when it's about to expire.
   */
  refreshTokenOutlivesAccessToken?: boolean;

  /** The post format this platform will use for these media, or null if it can't post them. */
  chooseFormat(media: FormatMedia[]): PostFormat | null;
  /** Problems that would make the platform reject the post; empty when it's fine. */
  validatePost(request: PublishRequest): string[];
  /**
   * Publishes step by step. Safe to call repeatedly: it resumes from `state`, and throws
   * PlatformApiError on failure (see isRetryable).
   */
  publish(ctx: PublishContext): Promise<PublishResult>;
  /**
   * A cheap call proving the stored token still works for this account, returning its current
   * profile (names and pictures change). Throws PlatformApiError, e.g. INVALID_TOKEN, when it doesn't.
   */
  checkAccount?(ctx: InsightsContext): Promise<Partial<Omit<ConnectedProfile, "externalId" | "appScopedId" | "accountType">>>;
  /** Reading post and account numbers. Absent for platforms without analytics yet. */
  insights?: InsightsProvider;
}

/** An error from a platform API, with a code we can act on. */
export class PlatformApiError extends Error {
  constructor(
    public readonly platform: SocialPlatform,
    public readonly code:
      | "INVALID_TOKEN"
      | "PERMISSION_DENIED"
      | "RATE_LIMITED"
      | "BAD_REQUEST"
      | "UNAVAILABLE"
      /** The platform refused the media itself (format, size, processing error). */
      | "MEDIA_REJECTED"
      /** Temporary: the platform lost track of an in-progress upload; retry from scratch. */
      | "MEDIA_EXPIRED",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }

  /** Worth trying again later. Everything else needs a person to fix something first. */
  get retryable(): boolean {
    return this.code === "RATE_LIMITED" || this.code === "UNAVAILABLE" || this.code === "MEDIA_EXPIRED";
  }
}
