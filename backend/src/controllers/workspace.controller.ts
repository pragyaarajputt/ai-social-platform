import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { listPlatforms, platformFromSlug } from "../integrations/registry.js";
import {
  completeConnect,
  ConnectError,
  disconnectSocialAccount,
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

export const disconnectAccount: RequestHandler = async (req, res) => {
  await disconnectSocialAccount({
    workspaceId: req.workspace!.id,
    accountId: String(req.params.accountId),
    actorId: req.user!.id,
  });
  res.status(204).end();
};

// ─── Platform callbacks (/integrations/:platform/...) ───────────────────────

/** The platform redirects the browser here after the consent screen; we redirect back to the app. */
export const oauthCallback: RequestHandler = async (req, res) => {
  const slug = String(req.params.platform);
  const platform = platformFromSlug(slug);
  const back = (query: string) => res.redirect(`${env.appUrl}/accounts?${query}`);
  const q = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  try {
    await completeConnect({ platform, code: q(req.query.code), state: q(req.query.state), error: q(req.query.error) });
    back(`connected=${encodeURIComponent(slug)}`);
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
  // Only Meta platforms send signed requests; Instagram is the only one so far.
  if (platform !== "INSTAGRAM" || !env.instagram) throw new AppError(404, "NOT_FOUND", "Not found");
  const payload = parseSignedRequest(req.body?.signed_request, env.instagram.appSecret);
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
