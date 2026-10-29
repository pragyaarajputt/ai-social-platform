import type { RequestHandler } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { listPlatforms, platformFromSlug } from "../integrations/registry.js";
import {
  completeConnect,
  ConnectError,
  connectWithAppPassword,
  disconnectSocialAccount,
  getDisconnectImpact,
  getDataDeletionStatus,
  handleDataDeletion,
  handleDeauthorize,
  listSocialAccounts,
  startConnect,
} from "../services/socialAccount.service.js";
import { listWorkspacesForUser } from "../services/workspace.service.js";
import { AppError } from "../utils/AppError.js";
import { parseSignedRequest } from "../utils/metaSignedRequest.js";

// ─── Workspaces ─────────────────────────────────────────────────────────────

export const listWorkspaces: RequestHandler = async (req, res) => {
  res.json({ workspaces: await listWorkspacesForUser(req.user!.id) });
};

// ─── Connected accounts (under /workspaces/:workspaceId) ────────────────────

export const listAccounts: RequestHandler = async (req, res) => {
  res.json({ accounts: await listSocialAccounts(req.workspace!.id), platforms: listPlatforms() });
};

export const connectAccount: RequestHandler = async (req, res) => {
  const platform = platformFromSlug(String(req.params.platform));
  res.json(await startConnect({ userId: req.user!.id, workspaceId: req.workspace!.id, platform }));
};

/** For platforms that connect with an app password (Bluesky). The password is never stored or logged. */
export const connectAccountWithAppPassword: RequestHandler = async (req, res) => {
  const platform = platformFromSlug(String(req.params.platform));
  const { identifier, appPassword } = appPasswordSchema.parse(req.body ?? {});
  const { accounts, skippedElsewhere } = await connectWithAppPassword({ userId: req.user!.id, workspaceId: req.workspace!.id, platform, identifier, appPassword });
  res.status(201).json({ accounts, skippedElsewhere });
};

const appPasswordSchema = z.object({
  identifier: z.string().trim().min(1, "Enter your handle").max(253, "That handle is too long"),
  appPassword: z.string().trim().min(1, "Enter an app password").max(100, "That app password is too long"),
});

export const disconnectImpact: RequestHandler = async (req, res) => {
  res.json(await getDisconnectImpact(req.workspace!.id, accountIdParam(req.params.accountId)));
};

export const disconnectAccount: RequestHandler = async (req, res) => {
  const { scheduledPosts } = disconnectSchema.parse(req.body ?? {});
  res.json(
    await disconnectSocialAccount({
      workspaceId: req.workspace!.id,
      accountId: accountIdParam(req.params.accountId),
      actorId: req.user!.id,
      scheduledPosts,
    }),
  );
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function accountIdParam(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Connected account not found");
  return value;
}

/** Scheduled posts that use the account are cancelled for it unless the user chose to keep them. */
const disconnectSchema = z.object({ scheduledPosts: z.enum(["cancel", "keep"]).default("cancel") });

// ─── Platform callbacks (/integrations/:platform/...) ───────────────────────

/** The platform redirects the browser here after the consent screen; we redirect back to the app. */
export const oauthCallback: RequestHandler = async (req, res) => {
  const slug = String(req.params.platform);
  const platform = platformFromSlug(slug);
  const back = (query: string) => res.redirect(`${env.appUrl}/accounts?${query}`);
  const q = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  try {
    const { accounts, skippedElsewhere } = await completeConnect({ platform, code: q(req.query.code), state: q(req.query.state), error: q(req.query.error) });
    back(`connected=${encodeURIComponent(slug)}&count=${accounts.length}${skippedElsewhere ? `&elsewhere=${skippedElsewhere}` : ""}`);
  } catch (err) {
    if (err instanceof ConnectError) {
      if (err.reason === "platform_error") console.error(`[${platform}] connect failed:`, err.message);
      back(`error=${err.reason}&platform=${encodeURIComponent(slug)}`);
      return;
    }
    console.error(`[${platform}] connect failed:`, err);
    back(`error=platform_error&platform=${encodeURIComponent(slug)}`);
  }
};

function verifiedMetaUser(req: Parameters<RequestHandler>[0]): { platform: ReturnType<typeof platformFromSlug>; userId: string } {
  const platform = platformFromSlug(String(req.params.platform));
  // Only Meta platforms send signed requests, each signed with its own app secret.
  const appSecret = platform === "INSTAGRAM" ? env.instagram?.appSecret : platform === "FACEBOOK" ? env.facebook?.appSecret : undefined;
  if (!appSecret) throw new AppError(404, "NOT_FOUND", "Not found");
  const payload = parseSignedRequest(req.body?.signed_request, appSecret);
  if (!payload) throw new AppError(400, "INVALID_SIGNED_REQUEST", "Invalid signed_request");
  return { platform, userId: payload.user_id };
}

/** Meta calls this when a user removes our app from their account. */
export const deauthorize: RequestHandler = async (req, res) => {
  const { platform, userId } = verifiedMetaUser(req);
  await handleDeauthorize(platform, userId);
  res.json({ success: true });
};

/** Meta calls this when a user asks for their data to be deleted. It expects { url, confirmation_code }. */
export const dataDeletion: RequestHandler = async (req, res) => {
  const { platform, userId } = verifiedMetaUser(req);
  const confirmationCode = await handleDataDeletion(platform, userId);
  const statusUrl = `${req.protocol}://${req.get("host")}/api/v1/integrations/${String(req.params.platform)}/data-deletion/${confirmationCode}`;
  res.json({ url: statusUrl, confirmation_code: confirmationCode });
};

export const dataDeletionStatus: RequestHandler = async (req, res) => {
  const status = await getDataDeletionStatus(String(req.params.code));
  if (!status) throw new AppError(404, "NOT_FOUND", "No deletion request with this code");
  res.json(status);
};
