import type { RequestHandler } from "express";
import { verifyAccessToken } from "../services/token.service.js";
import { AppError } from "../utils/AppError.js";

/** Requires `Authorization: Bearer <access token>` and sets req.user. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHENTICATED", "Sign in to continue");
  }
  req.user = await verifyAccessToken(header.slice("Bearer ".length).trim());
  next();
};
