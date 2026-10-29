import express, { Router } from "express";
import * as ai from "../controllers/ai.controller.js";
import * as analytics from "../controllers/analytics.controller.js";
import * as content from "../controllers/content.controller.js";
import * as team from "../controllers/team.controller.js";
import * as ws from "../controllers/workspace.controller.js";
import { aiLimiter, authLimiter } from "../middleware/rateLimits.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { validateBody } from "../middleware/validate.js";
import { brandVoiceSchema, captionsSchema, feedbackSchema, hashtagsSchema, rewriteSchema } from "../schemas/ai.schemas.js";
import { createPostSchema, registerMediaSchema, updatePostSchema } from "../schemas/post.schemas.js";

// /api/v1/workspaces
export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);
workspaceRouter.get("/", ws.listWorkspaces);
workspaceRouter.post("/", team.createWorkspace);
workspaceRouter.patch("/:workspaceId", requireWorkspace("ADMIN"), team.renameWorkspace);
workspaceRouter.delete("/:workspaceId", requireWorkspace("OWNER"), team.deleteWorkspace);

// Team: members and invites.
workspaceRouter.get("/:workspaceId/members", requireWorkspace("VIEWER"), team.listMembers);
workspaceRouter.post("/:workspaceId/members/me/leave", requireWorkspace("VIEWER"), team.leave);
workspaceRouter.patch("/:workspaceId/members/:userId", requireWorkspace("ADMIN"), team.changeRole);
workspaceRouter.delete("/:workspaceId/members/:userId", requireWorkspace("ADMIN"), team.removeMember);
workspaceRouter.post("/:workspaceId/transfer-ownership", requireWorkspace("OWNER"), team.transferOwnership);
workspaceRouter.get("/:workspaceId/invites", requireWorkspace("ADMIN"), team.listInvites);
workspaceRouter.post("/:workspaceId/invites", requireWorkspace("ADMIN"), team.createInvite);
workspaceRouter.post("/:workspaceId/invites/:inviteId/resend", requireWorkspace("ADMIN"), team.resendInvite);
workspaceRouter.delete("/:workspaceId/invites/:inviteId", requireWorkspace("ADMIN"), team.revokeInvite);
workspaceRouter.get("/:workspaceId/social-accounts", requireWorkspace("VIEWER"), ws.listAccounts);
workspaceRouter.post("/:workspaceId/social-accounts/:platform/connect", requireWorkspace("ADMIN"), ws.connectAccount);
// Signing in with an app password (Bluesky): rate-limited per IP like the other sign-in endpoints.
workspaceRouter.post("/:workspaceId/social-accounts/:platform/app-password", authLimiter, requireWorkspace("ADMIN"), ws.connectAccountWithAppPassword);
workspaceRouter.get("/:workspaceId/social-accounts/:accountId/disconnect-impact", requireWorkspace("ADMIN"), ws.disconnectImpact);
workspaceRouter.delete("/:workspaceId/social-accounts/:accountId", requireWorkspace("ADMIN"), ws.disconnectAccount);

workspaceRouter.post("/:workspaceId/media/upload-signature", requireWorkspace("EDITOR"), content.uploadSignature);
workspaceRouter.post("/:workspaceId/media", requireWorkspace("EDITOR"), validateBody(registerMediaSchema), content.registerMedia);
workspaceRouter.get("/:workspaceId/media", requireWorkspace("VIEWER"), content.listMedia);
workspaceRouter.delete("/:workspaceId/media/:mediaId", requireWorkspace("EDITOR"), content.deleteMedia);

workspaceRouter.post("/:workspaceId/posts", requireWorkspace("EDITOR"), validateBody(createPostSchema), content.createPost);
workspaceRouter.get("/:workspaceId/posts", requireWorkspace("VIEWER"), content.listPosts);
// Before /posts/:postId, so "at-risk" isn't taken for a post ID.
workspaceRouter.get("/:workspaceId/posts/at-risk", requireWorkspace("VIEWER"), content.listAtRisk);
workspaceRouter.get("/:workspaceId/posts/:postId", requireWorkspace("VIEWER"), content.getPost);
workspaceRouter.patch("/:workspaceId/posts/:postId", requireWorkspace("EDITOR"), validateBody(updatePostSchema), content.updatePost);
workspaceRouter.post("/:workspaceId/posts/:postId/cancel", requireWorkspace("EDITOR"), content.cancelPost);
workspaceRouter.delete("/:workspaceId/posts/:postId", requireWorkspace("EDITOR"), content.deletePost);
workspaceRouter.post("/:workspaceId/posts/:postId/targets/:targetId/retry", requireWorkspace("EDITOR"), content.retryTarget);

// AI writing tools: suggestions only; nothing is saved to a post until the user applies it.
workspaceRouter.post("/:workspaceId/ai/captions", requireWorkspace("EDITOR"), aiLimiter, validateBody(captionsSchema), ai.captions);
workspaceRouter.post("/:workspaceId/ai/hashtags", requireWorkspace("EDITOR"), aiLimiter, validateBody(hashtagsSchema), ai.hashtags);
workspaceRouter.post("/:workspaceId/ai/rewrite", requireWorkspace("EDITOR"), aiLimiter, validateBody(rewriteSchema), ai.rewrite);
workspaceRouter.post("/:workspaceId/ai/requests/:requestId/feedback", requireWorkspace("EDITOR"), validateBody(feedbackSchema), ai.feedback);
workspaceRouter.get("/:workspaceId/ai/usage", requireWorkspace("VIEWER"), ai.usage);
workspaceRouter.get("/:workspaceId/brand-voice", requireWorkspace("VIEWER"), ai.getVoice);
workspaceRouter.put("/:workspaceId/brand-voice", requireWorkspace("ADMIN"), validateBody(brandVoiceSchema), ai.putVoice);

// Analytics: read from our own tables, filled by the worker.
workspaceRouter.get("/:workspaceId/analytics/overview", requireWorkspace("VIEWER"), analytics.overview);
workspaceRouter.get("/:workspaceId/analytics/posts", requireWorkspace("VIEWER"), analytics.topPosts);
workspaceRouter.get("/:workspaceId/analytics/best-times", requireWorkspace("VIEWER"), analytics.bestTimes);

// /api/v1/invites: the link in invite emails. Previewing needs no sign-in; accepting does.
export const inviteRouter = Router();
inviteRouter.get("/:token", authLimiter, team.previewInvite);
inviteRouter.post("/:token/accept", requireAuth, authLimiter, team.acceptInvite);

// /api/v1/integrations: called by the platforms, not by our frontend, so no requireAuth.
export const integrationRouter = Router();

integrationRouter.get("/:platform/callback", authLimiter, ws.oauthCallback);
// Meta posts signed requests as form data.
const form = express.urlencoded({ extended: false, limit: "10kb" });
integrationRouter.post("/:platform/deauthorize", form, ws.deauthorize);
integrationRouter.post("/:platform/data-deletion", form, ws.dataDeletion);
integrationRouter.get("/:platform/data-deletion/:code", ws.dataDeletionStatus);
