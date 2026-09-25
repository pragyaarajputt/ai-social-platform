import express, { Router } from "express";
import * as ws from "../controllers/workspace.controller.js";
import { authLimiter } from "../middleware/rateLimits.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";

// /api/v1/workspaces
export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);
workspaceRouter.get("/", ws.listWorkspaces);
workspaceRouter.get("/:workspaceId/social-accounts", requireWorkspace("VIEWER"), ws.listAccounts);
workspaceRouter.post("/:workspaceId/social-accounts/:platform/connect", requireWorkspace("ADMIN"), ws.connectAccount);
workspaceRouter.delete("/:workspaceId/social-accounts/:accountId", requireWorkspace("ADMIN"), ws.disconnectAccount);

// /api/v1/integrations: called by the platforms, not by our frontend, so no requireAuth.
export const integrationRouter = Router();

integrationRouter.get("/:platform/callback", authLimiter, ws.oauthCallback);
// Meta posts signed requests as form data.
const form = express.urlencoded({ extended: false, limit: "10kb" });
integrationRouter.post("/:platform/deauthorize", form, ws.deauthorize);
integrationRouter.post("/:platform/data-deletion", form, ws.dataDeletion);
integrationRouter.get("/:platform/data-deletion/:code", ws.dataDeletionStatus);
