import type { RequestHandler } from "express";
import * as ai from "../services/ai.service.js";
import { getBrandVoice, saveBrandVoice } from "../services/brandVoice.service.js";
import { AppError } from "../utils/AppError.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ctx = (req: Parameters<RequestHandler>[0]) => ({ workspaceId: req.workspace!.id, userId: req.user!.id });

export const captions: RequestHandler = async (req, res) => {
  res.json(await ai.generateCaptions(ctx(req), req.body));
};

export const hashtags: RequestHandler = async (req, res) => {
  res.json(await ai.suggestHashtags(ctx(req), req.body));
};

export const rewrite: RequestHandler = async (req, res) => {
  res.json(await ai.rewrite(ctx(req), req.body));
};

export const feedback: RequestHandler = async (req, res) => {
  const requestId = req.params.requestId;
  if (typeof requestId !== "string" || !UUID.test(requestId)) throw new AppError(404, "AI_REQUEST_NOT_FOUND", "AI request not found");
  await ai.recordFeedback(req.workspace!.id, requestId, req.body);
  res.status(204).end();
};

export const usage: RequestHandler = async (req, res) => {
  res.json(await ai.getUsage(req.workspace!.id));
};

export const getVoice: RequestHandler = async (req, res) => {
  res.json({ brandVoice: await getBrandVoice(req.workspace!.id) });
};

export const putVoice: RequestHandler = async (req, res) => {
  res.json({ brandVoice: await saveBrandVoice(req.workspace!.id, req.user!.id, req.body) });
};
