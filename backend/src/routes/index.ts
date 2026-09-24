import { Router } from "express";
import { prisma } from "../config/database.js";

export const router = Router();

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
