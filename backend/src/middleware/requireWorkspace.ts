import type { RequestHandler } from "express";
import type { WorkspaceRole } from "../generated/prisma/enums.js";
import { getMembership, hasRole } from "../services/workspace.service.js";
import { AppError } from "../utils/AppError.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * For routes under /workspaces/:workspaceId. Runs after requireAuth.
 * Non-members get 404, not 403, so workspace IDs can't be probed.
 */
export function requireWorkspace(minimumRole: WorkspaceRole = "VIEWER"): RequestHandler {
  return async (req, _res, next) => {
    const workspaceId = req.params.workspaceId;
    const notFound = new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) throw notFound;

    const membership = await getMembership(workspaceId, req.user!.id);
    if (!membership) throw notFound;
    if (!hasRole(membership.role, minimumRole)) {
      throw new AppError(403, "INSUFFICIENT_ROLE", "Your role in this workspace doesn't allow this");
    }
    req.workspace = { id: workspaceId, role: membership.role };
    next();
  };
}
