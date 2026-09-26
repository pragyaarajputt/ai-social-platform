import { api } from "./api";
import type { Workspace, WorkspaceRole } from "./workspaces";

// Workspaces, members and invites. The server enforces every rule; the helpers here only decide
// which controls to show.

export type AssignableRole = Exclude<WorkspaceRole, "OWNER">;

export const ROLE_LABELS: Record<WorkspaceRole, string> = { OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", VIEWER: "Viewer" };
export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  OWNER: "Everything, including transferring ownership and deleting the workspace",
  ADMIN: "Connect accounts, manage the team and brand voice, and everything editors can do",
  EDITOR: "Create, edit and schedule posts; upload media; use AI",
  VIEWER: "See posts, calendar and analytics",
};

const rank: Record<WorkspaceRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };
export const atLeast = (role: WorkspaceRole, minimum: WorkspaceRole) => rank[role] >= rank[minimum];

/** Create, edit and schedule posts; upload media; use AI. */
export const canEditPosts = (role: WorkspaceRole) => atLeast(role, "EDITOR");

/** Whether `actor` may change or remove `target` (mirrors the server's rules). */
export function canManageMember(actor: { userId: string; role: WorkspaceRole }, target: { userId: string; role: WorkspaceRole }): boolean {
  if (actor.userId === target.userId || target.role === "OWNER") return false;
  if (actor.role === "OWNER") return true;
  return actor.role === "ADMIN" && target.role !== "ADMIN";
}

/** Roles `actor` can give when inviting or changing a role. */
export const assignableRoles = (actor: WorkspaceRole): AssignableRole[] => (atLeast(actor, "ADMIN") ? ["ADMIN", "EDITOR", "VIEWER"] : []);

export interface Member {
  userId: string;
  username: string;
  displayName: string;
  /** Only shown to owners and admins (and to the person themselves). */
  email: string | null;
  role: WorkspaceRole;
  joinedAt: string;
  connectedAccounts: number;
}

export interface Invite {
  id: string;
  email: string;
  role: AssignableRole;
  state: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
  lastSentAt: string;
  createdAt: string;
}

export interface InvitePreview {
  workspaceName: string;
  inviterName: string;
  role: AssignableRole;
  /** Masked, e.g. "p***@example.com". */
  email: string;
  state: Invite["state"];
  expiresAt: string;
}

const base = (id: string) => `/workspaces/${id}`;

export const createWorkspace = async (name: string) =>
  (await api<{ workspace: Workspace }>("/workspaces", { method: "POST", body: { name } })).workspace;
export const renameWorkspace = (id: string, name: string) => api<void>(base(id), { method: "PATCH", body: { name } });
export const deleteWorkspace = (id: string, confirm: { confirmName: string; password?: string }) =>
  api<void>(base(id), { method: "DELETE", body: confirm });

export const listMembers = async (id: string) => (await api<{ members: Member[] }>(`${base(id)}/members`)).members;
export const changeRole = (id: string, userId: string, role: AssignableRole) =>
  api<void>(`${base(id)}/members/${userId}`, { method: "PATCH", body: { role } });
export const removeMember = (id: string, userId: string, disconnectAccounts: boolean) =>
  api<{ disconnectedAccounts: number }>(`${base(id)}/members/${userId}`, { method: "DELETE", body: { disconnectAccounts } });
export const leaveWorkspace = (id: string) => api<void>(`${base(id)}/members/me/leave`, { method: "POST" });
export const transferOwnership = (id: string, body: { userId: string; confirmName: string; password?: string }) =>
  api<void>(`${base(id)}/transfer-ownership`, { method: "POST", body });

export const listInvites = async (id: string) => (await api<{ invites: Invite[] }>(`${base(id)}/invites`)).invites;
export const createInvite = (id: string, email: string, role: AssignableRole) =>
  api<{ invite: Invite; link: string }>(`${base(id)}/invites`, { method: "POST", body: { email, role } });
export const resendInvite = (id: string, inviteId: string) => api<{ invite: Invite; link: string }>(`${base(id)}/invites/${inviteId}/resend`, { method: "POST" });
export const revokeInvite = (id: string, inviteId: string) => api<void>(`${base(id)}/invites/${inviteId}`, { method: "DELETE" });

export const previewInvite = async (token: string) =>
  (await api<{ invite: InvitePreview }>(`/invites/${encodeURIComponent(token)}`, { auth: false })).invite;
export const acceptInvite = (token: string) => api<{ workspaceId: string }>(`/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
