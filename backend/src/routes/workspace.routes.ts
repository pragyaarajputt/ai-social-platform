import express, { Router } from "express";
import * as content from "../controllers/content.controller.js";
import * as ws from "../controllers/workspace.controller.js";
import { authLimiter } from "../middleware/rateLimits.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { validateBody } from "../middleware/validate.js";
import { createPostSchema, registerMediaSchema } from "../schemas/post.schemas.js";

// /api/v1/workspaces
export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);
workspaceRouter.get("/", ws.listWorkspaces);
workspaceRouter.get("/:workspaceId/social-accounts", requireWorkspace("VIEWER"), ws.listAccounts);
workspaceRouter.post("/:workspaceId/social-accounts/:platform/connect", requireWorkspace("ADMIN"), ws.connectAccount);
workspaceRouter.delete("/:workspaceId/social-accounts/:accountId", requireWorkspace("ADMIN"), ws.disconnectAccount);

workspaceRouter.post("/:workspaceId/media/upload-signature", requireWorkspace("EDITOR"), content.uploadSignature);
workspaceRouter.post("/:workspaceId/media", requireWorkspace("EDITOR"), validateBody(registerMediaSchema), content.registerMedia);
workspaceRouter.get("/:workspaceId/media", requireWorkspace("VIEWER"), content.listMedia);
workspaceRouter.delete("/:workspaceId/media/:mediaId", requireWorkspace("EDITOR"), content.deleteMedia);

workspaceRouter.post("/:workspaceId/posts", requireWorkspace("EDITOR"), validateBody(createPostSchema), content.createPost);
workspaceRouter.get("/:workspaceId/posts", requireWorkspace("VIEWER"), content.listPosts);
workspaceRouter.get("/:workspaceId/posts/:postId", requireWorkspace("VIEWER"), content.getPost);
workspaceRouter.post("/:workspaceId/posts/:postId/targets/:targetId/retry", requireWorkspace("EDITOR"), content.retryTarget);

// /api/v1/integrations: called by the platforms, not by our frontend, so no requireAuth.
export const integrationRouter = Router();

integrationRouter.get("/:platform/callback", authLimiter, ws.oauthCallback);
// Meta posts signed requests as form data.
const form = express.urlencoded({ extended: false, limit: "10kb" });
integrationRouter.post("/:platform/deauthorize", form, ws.deauthorize);
integrationRouter.post("/:platform/data-deletion", form, ws.dataDeletion);
integrationRouter.get("/:platform/data-deletion/:code", ws.dataDeletionStatus);
