import { api } from "./api";

export type WorkspaceRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: WorkspaceRole;
}

export type SocialPlatform = "INSTAGRAM" | "FACEBOOK" | "THREADS" | "LINKEDIN" | "X" | "YOUTUBE" | "TIKTOK";

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
  createdAt: string;
  tokenExpiresAt: string | null;
  tokenRefreshedAt: string | null;
}

export interface PlatformInfo {
  platform: SocialPlatform;
  displayName: string;
  /** False when the server has no app credentials for this platform yet. */
  configured: boolean;
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

export function disconnectAccount(workspaceId: string, accountId: string): Promise<void> {
  return api(`/workspaces/${workspaceId}/social-accounts/${accountId}`, { method: "DELETE" });
}
