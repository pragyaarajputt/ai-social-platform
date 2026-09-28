import { env } from "../config/env.js";
import { claudeProvider } from "./claude.js";
import { geminiProvider } from "./gemini.js";
import type { AiProvider } from "./types.js";

/** The provider chosen with AI_PROVIDER (read on each call, so a restart isn't needed in tests). */
export function aiProvider(): AiProvider {
  return env.ai.provider === "gemini" ? geminiProvider : claudeProvider;
}
