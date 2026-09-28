import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse, type Part as GeminiPart } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import type { TokenUsage } from "./pricing.js";
import { checkOutput, type AiProvider, type GenerateRequest, type GenerateResult, type Part } from "./types.js";

// Google Gemini through the official @google/genai SDK (checked against v2.24's types).
// https://ai.google.dev/gemini-api/docs/structured-output
// On Gemini's free tier Google may use prompts to improve its products (ai.google.dev pricing page),
// so use the paid tier (or Claude) before real users' content goes through it.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A response stopped for any of these reasons was declined by Gemini's safety systems.
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY", "RECITATION"]);

function client(): GoogleGenAI {
  const key = env.ai.gemini.apiKey;
  if (!key) throw new AppError(501, "NOT_CONFIGURED", "AI writing isn't set up on this server yet");
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: { timeout: 60_000, retryOptions: { attempts: env.ai.maxRetries + 1 } },
  });
}

/**
 * Gemini can't be relied on to fetch images from any web address, so the server downloads them and
 * sends them inline. Only from our own Cloudinary account, so this can never be used to make the
 * server fetch other addresses.
 */
async function imagePart(url: string): Promise<GeminiPart> {
  const cloud = env.cloudinary?.cloudName;
  const allowed = cloud !== undefined && url.startsWith(`https://res.cloudinary.com/${cloud}/`);
  if (!allowed) throw new AppError(400, "MEDIA_NOT_ALLOWED", "Only photos from this app's media library can be sent to AI.");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AppError(502, "MEDIA_UNAVAILABLE", "Couldn't read the photo to send it to AI. Try again.");
  }
  const type = res.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !type.startsWith("image/") || bytes.length > MAX_IMAGE_BYTES) {
    throw new AppError(502, "MEDIA_UNAVAILABLE", "Couldn't read the photo to send it to AI. Try again.");
  }
  return { inlineData: { mimeType: type.split(";")[0]!, data: bytes.toString("base64") } };
}

async function toContents(parts: Part[]): Promise<Content[]> {
  const out: GeminiPart[] = [];
  for (const p of parts) out.push(p.type === "image" ? await imagePart(p.url) : { text: p.text });
  return [{ role: "user", parts: out }];
}

function usageOf(r: GenerateContentResponse): TokenUsage {
  const u = r.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
    // Thinking tokens are billed as output.
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

export const geminiProvider: AiProvider = {
  name: "gemini",
  isConfigured: () => env.ai.gemini.apiKey !== undefined,
  model: () => env.ai.gemini.model,
  isFree: () => env.ai.gemini.freeTier,

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const model = env.ai.gemini.model;
    const contents = await toContents(req.content);
    let response: GenerateContentResponse;
    try {
      response = await client().models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: req.system.map((b) => b.text).join("\n\n"),
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(req.schema),
          maxOutputTokens: 8000,
        },
      });
    } catch (err) {
      throw toAppError(err);
    }

    const base = { model: response.modelVersion ?? model, usage: usageOf(response) };
    if (response.promptFeedback?.blockReason) return { ...base, kind: "refused" };
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason && BLOCKED.has(candidate.finishReason)) return { ...base, kind: "refused" };
    if (candidate?.finishReason === "MAX_TOKENS") return { ...base, kind: "bad_output", reason: "max_tokens" };

    const checked = checkOutput(response.text, req.schema);
    return checked.ok ? { ...base, kind: "ok", output: checked.value } : { ...base, kind: "bad_output", reason: checked.reason };
  },
};

/** API errors → what our users see. Details go to the server log, never to the browser. */
function toAppError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const status = err instanceof ApiError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  // A bad key comes back as 400 "API key not valid"; a key without access as 401/403.
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(message))) {
    console.error(`Gemini rejected the API key (HTTP ${status}). Check GEMINI_API_KEY.`);
    return new AppError(502, "AI_UNAVAILABLE", "AI writing isn't available right now");
  }
  if (status === 429 || (status !== undefined && status >= 500) || status === undefined) {
    console.warn(`Gemini unavailable${status ? ` (HTTP ${status})` : ""}: ${message}`);
    return new AppError(503, "AI_BUSY", "AI is busy right now. Try again in a minute.");
  }
  console.error(`Gemini request failed (HTTP ${status}): ${message}`);
  return new AppError(502, "AI_UNAVAILABLE", "AI writing isn't available right now");
}
