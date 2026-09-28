import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaContentBlockParam, BetaTextBlockParam, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import type { TokenUsage } from "./pricing.js";
import { checkOutput, type AiProvider, type GenerateRequest, type GenerateResult, type Part, type SystemBlock } from "./types.js";

// Claude through the official SDK. Every response is checked against a Zod schema, and refusals,
// unusable output and API errors are told apart for logging.

let client: { key: string; sdk: Anthropic } | undefined;
function getClient(): Anthropic {
  const key = env.ai.apiKey;
  if (!key) throw new AppError(501, "NOT_CONFIGURED", "AI writing isn't set up on this server yet");
  if (client?.key !== key) {
    client = {
      key,
      sdk: new Anthropic({
        apiKey: key,
        maxRetries: env.ai.maxRetries,
        timeout: 60_000,
        // Looked up on every call (not captured once), so tests can replace global fetch.
        fetch: (url, init) => globalThis.fetch(url, init),
      }),
    };
  }
  return client.sdk;
}

// Haiku 4.5 predates the effort setting.
const supportsEffort = (model: string) => !model.startsWith("claude-haiku-4-5");
// Server-side refusal fallback: if Claude Opus 5's safety classifiers decline a request, the API
// re-runs it on the model Anthropic recommends for that case, within the same call.
const supportsDefaultFallback = (model: string) => model === "claude-opus-5" || model.startsWith("claude-opus-5-2");

const toSystem = (blocks: SystemBlock[]): BetaTextBlockParam[] =>
  // Stable blocks are cached, so repeated requests pay less for them.
  blocks.map((b) => ({ type: "text", text: b.text, ...(b.cache && { cache_control: { type: "ephemeral" as const } }) }));

const toContent = (parts: Part[]): BetaContentBlockParam[] =>
  parts.map((p) => (p.type === "image" ? { type: "image", source: { type: "url", url: p.url } } : { type: "text", text: p.text }));

export const claudeProvider: AiProvider = {
  name: "anthropic",
  isConfigured: () => env.ai.apiKey !== undefined,
  model: () => env.ai.model,
  isFree: () => false,

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const model = env.ai.model;
    const format = betaZodOutputFormat(req.schema);
    const params: MessageCreateParamsNonStreaming = {
      model,
      // Room for adaptive thinking plus a few captions; only what's used is billed.
      max_tokens: 8000,
      system: toSystem(req.system),
      messages: [{ role: "user", content: toContent(req.content) }],
      // Short writing tasks don't need deep thinking; low effort keeps them quick and cheap.
      output_config: { format: { type: format.type, schema: format.schema }, ...(supportsEffort(model) && { effort: "low" }) },
      metadata: { user_id: req.userId },
      ...(supportsDefaultFallback(model) && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
    };

    let response;
    try {
      response = await getClient().beta.messages.create(params);
    } catch (err) {
      throw toAppError(err);
    }

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const base = { model: response.model, usage };

    // A refusal after every fallback model declined. Checked before reading the content.
    if (response.stop_reason === "refusal") return { ...base, kind: "refused" };
    if (response.stop_reason === "max_tokens") return { ...base, kind: "bad_output", reason: "max_tokens" };

    const text = response.content.findLast((b) => b.type === "text");
    const checked = checkOutput(text?.type === "text" ? text.text : undefined, req.schema);
    return checked.ok ? { ...base, kind: "ok", output: checked.value } : { ...base, kind: "bad_output", reason: checked.reason };
  },
};

/** SDK errors → what our users see. Details go to the server log, never to the browser. */
function toAppError(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.error(`Claude rejected the API key (HTTP ${err.status}). Check ANTHROPIC_API_KEY.`);
    return new AppError(502, "AI_UNAVAILABLE", "AI writing isn't available right now");
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    console.warn(`Claude unavailable: ${err.message}`);
    return new AppError(503, "AI_BUSY", "AI is busy right now. Try again in a minute.");
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`Claude request failed (HTTP ${err.status}): ${err.message}`);
    return new AppError(502, "AI_UNAVAILABLE", "AI writing isn't available right now");
  }
  return err;
}
