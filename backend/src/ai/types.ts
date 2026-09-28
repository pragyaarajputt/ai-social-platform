import type { z } from "zod";
import type { TokenUsage } from "./pricing.js";

// What the AI writing tools need from a model provider, independent of the provider. Prompts are
// built once in these neutral parts; each provider (claude.ts, gemini.ts) turns them into its own
// request format and returns a checked, typed result.

/** A block of the system prompt. `cache: true` marks stable blocks a provider may cache. */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export type Part = { type: "text"; text: string } | { type: "image"; url: string };

export interface GenerateRequest<T> {
  system: SystemBlock[];
  content: Part[];
  /** The output must be JSON matching this schema. */
  schema: z.ZodType<T>;
  /** Our user ID, for providers that accept one for abuse investigations. No personal data. */
  userId: string;
}

export type GenerateResult<T> = { model: string; usage: TokenUsage } & (
  | { kind: "ok"; output: T }
  /** The provider's safety systems declined. */
  | { kind: "refused" }
  | { kind: "bad_output"; reason: string }
);

export interface AiProvider {
  name: "anthropic" | "gemini";
  isConfigured(): boolean;
  /** The model requests go to (the answering model can differ, e.g. after a fallback). */
  model(): string;
  /** Whether usage costs nothing (e.g. Gemini's free tier), so it's logged as $0. */
  isFree(): boolean;
  /** Throws AppError for API problems (bad key, rate limits, outages). */
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/** Parses a model's JSON text against the schema; shared by every provider. */
export function checkOutput<T>(text: string | undefined, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; reason: string } {
  if (!text) return { ok: false, reason: "no_text" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "schema_mismatch" };
}
