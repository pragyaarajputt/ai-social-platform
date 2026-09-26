import { Router } from "express";
import { prisma } from "../config/database.js";
import { authRouter } from "./auth.routes.js";
import { integrationRouter, inviteRouter, workspaceRouter } from "./workspace.routes.js";

export const router = Router();

router.use("/api/v1/auth", authRouter);
router.use("/api/v1/workspaces", workspaceRouter);
router.use("/api/v1/integrations", integrationRouter);
router.use("/api/v1/invites", inviteRouter);

router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "up" });
  } catch {
    res.status(503).json({ status: "unavailable", database: "down" });
  }
});
