import { randomBytes } from "node:crypto";
import { prisma } from "../config/database.js";
import type { WorkspaceRole } from "../generated/prisma/enums.js";

const roleRank: Record<WorkspaceRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };

export function hasRole(actual: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return roleRank[actual] >= roleRank[minimum];
}

/** Nested-create input for a new user's personal workspace, with them as owner. */
export function personalWorkspaceMembership(displayName: string) {
  return {
    create: {
      role: "OWNER" as const,
      workspace: {
        create: {
          name: `${displayName}'s workspace`.slice(0, 80),
          // Random, so it never depends on user input; "ws-" + 12 hex characters.
          slug: `ws-${randomBytes(6).toString("hex")}`,
        },
      },
    },
  };
}

export async function listWorkspacesForUser(userId: string) {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { role: true, workspace: { select: { id: true, name: true, slug: true, timezone: true } } },
  });
  return memberships.map((m) => ({ ...m.workspace, role: m.role }));
}

export async function getMembership(workspaceId: string, userId: string) {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
}
