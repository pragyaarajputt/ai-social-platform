import type { RequestHandler } from "express";
import { analyticsQuerySchema, bestTimesQuerySchema, topPostsQuerySchema } from "../schemas/analytics.schemas.js";
import * as analytics from "../services/analytics.service.js";

// Express 5 makes req.query read-only, so queries are parsed here rather than validated in place.

export const overview: RequestHandler = async (req, res) => {
  res.json(await analytics.getOverview(req.workspace!.id, analyticsQuerySchema.parse(req.query)));
};

export const topPosts: RequestHandler = async (req, res) => {
  res.json(await analytics.getTopPosts(req.workspace!.id, topPostsQuerySchema.parse(req.query)));
};

export const bestTimes: RequestHandler = async (req, res) => {
  res.json(await analytics.getBestTimes(req.workspace!.id, bestTimesQuerySchema.parse(req.query).accountId));
};
