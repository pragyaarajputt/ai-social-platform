import type { RequestHandler } from "express";
import {
  changeRoleSchema,
  createInviteSchema,
  createWorkspaceSchema,
  deleteWorkspaceSchema,
  removeMemberSchema,
  renameWorkspaceSchema,
  transferOwnershipSchema,
} from "../schemas/team.schemas.js";
import * as team from "../services/team.service.js";
import { AppError } from "../utils/AppError.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idParam(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AppError(404, code, message);
  return value;
}
const memberId = (v: unknown) => idParam(v, "MEMBER_NOT_FOUND", "That person isn't a member of this workspace.");
const inviteId = (v: unknown) => idParam(v, "INVITE_NOT_FOUND", "Invite not found");
const actor = (req: Parameters<RequestHandler>[0]) => ({ userId: req.user!.id, role: req.workspace!.role });

// ─── Workspaces ─────────────────────────────────────────────────────────────

export const createWorkspace: RequestHandler = async (req, res) => {
  res.status(201).json({ workspace: await team.createWorkspace(req.user!.id, createWorkspaceSchema.parse(req.body).name) });
};

export const renameWorkspace: RequestHandler = async (req, res) => {
  await team.renameWorkspace(req.workspace!.id, req.user!.id, renameWorkspaceSchema.parse(req.body).name);
  res.status(204).end();
};

export const deleteWorkspace: RequestHandler = async (req, res) => {
  await team.deleteWorkspace(req.workspace!.id, req.user!.id, deleteWorkspaceSchema.parse(req.body ?? {}));
  res.status(204).end();
};

// ─── Members ────────────────────────────────────────────────────────────────

export const listMembers: RequestHandler = async (req, res) => {
  res.json({ members: await team.listMembers(req.workspace!.id, actor(req)) });
};

export const changeRole: RequestHandler = async (req, res) => {
  await team.changeRole(req.workspace!.id, actor(req), memberId(req.params.userId), changeRoleSchema.parse(req.body).role);
  res.status(204).end();
};

export const removeMember: RequestHandler = async (req, res) => {
  const { disconnectAccounts } = removeMemberSchema.parse(req.body ?? {});
  res.json(await team.removeMember(req.workspace!.id, actor(req), memberId(req.params.userId), disconnectAccounts));
};

export const leave: RequestHandler = async (req, res) => {
  await team.leaveWorkspace(req.workspace!.id, req.user!.id);
  res.status(204).end();
};

export const transferOwnership: RequestHandler = async (req, res) => {
  await team.transferOwnership(req.workspace!.id, req.user!.id, transferOwnershipSchema.parse(req.body));
  res.status(204).end();
};

// ─── Invites ────────────────────────────────────────────────────────────────

export const listInvites: RequestHandler = async (req, res) => {
  res.json({ invites: await team.listInvites(req.workspace!.id) });
};

export const createInvite: RequestHandler = async (req, res) => {
  res.status(201).json(await team.createInvite(req.workspace!.id, actor(req), createInviteSchema.parse(req.body)));
};

export const resendInvite: RequestHandler = async (req, res) => {
  res.json(await team.resendInvite(req.workspace!.id, actor(req), inviteId(req.params.inviteId)));
};

export const revokeInvite: RequestHandler = async (req, res) => {
  await team.revokeInvite(req.workspace!.id, req.user!.id, inviteId(req.params.inviteId));
  res.status(204).end();
};

// ─── Invite links (/api/v1/invites/:token) ──────────────────────────────────

const token = (v: unknown) => {
  if (typeof v !== "string" || !/^[\w-]{20,100}$/.test(v)) throw new AppError(404, "INVITE_NOT_FOUND", "This invite link isn't valid.");
  return v;
};

export const previewInvite: RequestHandler = async (req, res) => {
  res.json({ invite: await team.previewInvite(token(req.params.token)) });
};

export const acceptInvite: RequestHandler = async (req, res) => {
  res.json(await team.acceptInvite(token(req.params.token), req.user!.id));
};
