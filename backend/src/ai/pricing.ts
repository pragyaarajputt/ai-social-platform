// Estimated cost of a Claude request, for the daily spend cap and usage reports. Prices are US dollars
// per million tokens (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-25).
// $1 per million tokens is one millionth of a dollar per token, so tokens × price = cost in micros.

interface Price {
  input: number;
  output: number;
}

const PRICES: [prefix: string, price: Price][] = [
  ["claude-fable-5-1", { input: 10, output: 50 }],
  ["claude-opus-5-5", { input: 4, output: 20 }],
  ["claude-opus-5", { input: 5, output: 25 }],
  ["claude-opus-4-8", { input: 5, output: 25 }],
  ["claude-sonnet-5", { input: 2, output: 10 }],
  ["claude-haiku-4-5", { input: 1, output: 5 }],
  // Gemini paid tier (ai.google.dev/gemini-api/docs/pricing, checked 2026-09-27; rises in 2027).
  ["gemini-3.8-flash", { input: 0.75, output: 3.75 }],
];
/** For a model we have no price for, assume the most expensive one so the spend cap still protects. */
const UNKNOWN: Price = { input: 10, output: 50 };

// Cache writes (5-minute cache) cost 1.25× input; cache reads 0.1×.
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function priceOf(model: string): Price {
  return PRICES.find(([prefix]) => model === prefix || model.startsWith(`${prefix}-`))?.[1] ?? UNKNOWN;
}

export function costMicros(model: string, u: TokenUsage): number {
  const p = priceOf(model);
  return Math.ceil(
    u.inputTokens * p.input + u.cacheWriteTokens * p.input * CACHE_WRITE + u.cacheReadTokens * p.input * CACHE_READ + u.outputTokens * p.output,
  );
}
