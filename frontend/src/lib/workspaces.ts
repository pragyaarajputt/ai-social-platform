import { api } from "./api";

export type WorkspaceRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** Created at sign-up. */
  isPersonal: boolean;
  role: WorkspaceRole;
}

export type SocialPlatform = "INSTAGRAM" | "FACEBOOK" | "THREADS" | "LINKEDIN" | "X" | "YOUTUBE" | "TIKTOK" | "BLUESKY";

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  externalId: string;
  accountType: string | null;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  status: "ACTIVE" | "NEEDS_REAUTH" | "REVOKED" | "DISCONNECTED";
  /** Instagram allowed reading insights; false until reconnected with that permission. */
  insightsAllowed: boolean;
  /** When the daily check last confirmed the connection works. */
  lastCheckedAt: string | null;
  /** Who connected it: the platform's tokens are issued to that person's own login. */
  connectedBy: { id: string; name: string; stillMember: boolean } | null;
  createdAt: string;
  tokenExpiresAt: string | null;
  tokenRefreshedAt: string | null;
  /** False when access ends at tokenExpiresAt unless someone reconnects (LinkedIn). */
  tokenRenews: boolean;
}

export interface PlatformInfo {
  platform: SocialPlatform;
  displayName: string;
  /** False when the server has no app credentials for this platform yet. */
  configured: boolean;
  /** "oauth": a redirect to the platform's consent screen; "app_password": a form here (Bluesky). */
  connectMethod: "oauth" | "app_password";
}

/** Roles that may connect and disconnect accounts (mirrors the backend's requireWorkspace("ADMIN")). */
export const canManageAccounts = (role: WorkspaceRole) => role === "OWNER" || role === "ADMIN";

export async function listWorkspaces(): Promise<Workspace[]> {
  return (await api<{ workspaces: Workspace[] }>("/workspaces")).workspaces;
}

export function listSocialAccounts(workspaceId: string) {
  return api<{ accounts: SocialAccount[]; platforms: PlatformInfo[] }>(`/workspaces/${workspaceId}/social-accounts`);
}

/** Returns the platform's consent-screen URL; the caller sends the browser there. */
export async function startConnect(workspaceId: string, platform: SocialPlatform): Promise<string> {
  const slug = platform.toLowerCase();
  const res = await api<{ authorizationUrl: string }>(`/workspaces/${workspaceId}/social-accounts/${slug}/connect`, {
    method: "POST",
  });
  return res.authorizationUrl;
}

/** Connects (or reconnects) an account that signs in with an app password (Bluesky). */
export function connectWithAppPassword(workspaceId: string, platform: SocialPlatform, identifier: string, appPassword: string) {
  return api<{ accounts: SocialAccount[]; skippedElsewhere: number }>(`/workspaces/${workspaceId}/social-accounts/${platform.toLowerCase()}/app-password`, {
    method: "POST",
    body: { identifier, appPassword },
  });
}

/** Scheduled posts that use the account, shown before disconnecting it. */
export function getDisconnectImpact(workspaceId: string, accountId: string) {
  return api<{ scheduledPosts: number; nextScheduledAt: string | null }>(`/workspaces/${workspaceId}/social-accounts/${accountId}/disconnect-impact`);
}

/** "cancel" removes this account from its scheduled posts; "keep" leaves them to publish if it's reconnected in time. */
export function disconnectAccount(workspaceId: string, accountId: string, scheduledPosts: "cancel" | "keep" = "cancel") {
  return api<{ cancelledTargets: number }>(`/workspaces/${workspaceId}/social-accounts/${accountId}`, { method: "DELETE", body: { scheduledPosts } });
}
