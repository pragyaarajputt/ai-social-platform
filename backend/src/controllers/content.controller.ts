import type { RequestHandler } from "express";
import * as media from "../services/media.service.js";
import * as posts from "../services/post.service.js";
import { AppError } from "../utils/AppError.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route IDs that aren't UUIDs can't exist; answer 404 instead of letting the database reject them. */
function idParam(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AppError(404, `${what.toUpperCase()}_NOT_FOUND`, `${what} not found`);
  return value;
}

// ─── Media ──────────────────────────────────────────────────────────────────

export const uploadSignature: RequestHandler = (req, res) => {
  res.json(media.createUploadSignature(req.workspace!.id));
};

export const registerMedia: RequestHandler = async (req, res) => {
  res.status(201).json({
    media: await media.registerMedia({ workspaceId: req.workspace!.id, userId: req.user!.id, ...req.body }),
  });
};

export const listMedia: RequestHandler = async (req, res) => {
  res.json({ media: await media.listMedia(req.workspace!.id) });
};

export const deleteMedia: RequestHandler = async (req, res) => {
  await media.deleteMedia(req.workspace!.id, idParam(req.params.mediaId, "Media"));
  res.status(204).end();
};

// ─── Posts ──────────────────────────────────────────────────────────────────

export const createPost: RequestHandler = async (req, res) => {
  res.status(201).json({ post: await posts.createPost(req.workspace!.id, req.user!.id, req.body) });
};

export const listPosts: RequestHandler = async (req, res) => {
  res.json({ posts: await posts.listPosts(req.workspace!.id) });
};

export const getPost: RequestHandler = async (req, res) => {
  res.json({ post: await posts.getPost(req.workspace!.id, idParam(req.params.postId, "Post")) });
};

export const retryTarget: RequestHandler = async (req, res) => {
  const post = await posts.retryTarget(
    req.workspace!.id,
    idParam(req.params.postId, "Post"),
    idParam(req.params.targetId, "Target"),
    req.user!.id,
  );
  res.json({ post });
};
