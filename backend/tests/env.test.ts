import { describe, expect, it } from "vitest";
import { productionProblems } from "../src/config/env.js";

const live = {
  APP_URL: "https://postdrip.app",
  CORS_ORIGIN: "https://postdrip.app",
  SMTP_URL: "smtps://resend:key@smtp.resend.com:465",
  TRUST_PROXY: "2",
  AI_PROVIDER: "gemini" as const,
  GEMINI_FREE_TIER: false,
};

describe("production settings check", () => {
  it("accepts a complete live configuration", () => {
    expect(productionProblems(live)).toEqual({ errors: [], warnings: [] });
  });

  it("refuses to start without HTTPS or with the API trusting another site", () => {
    expect(productionProblems({ ...live, APP_URL: "http://localhost:3000", CORS_ORIGIN: "http://localhost:3000" }).errors).toEqual([
      "APP_URL: must be an https:// address in production",
    ]);
    expect(productionProblems({ ...live, CORS_ORIGIN: "https://old-tunnel.trycloudflare.com" }).errors).toEqual([
      "CORS_ORIGIN: must be the same site as APP_URL",
    ]);
    // A trailing slash is the same site.
    expect(productionProblems({ ...live, CORS_ORIGIN: "https://postdrip.app/" }).errors).toEqual([]);
  });

  it("warns about settings that work but shouldn't be left like that", () => {
    const { warnings } = productionProblems({ ...live, SMTP_URL: undefined, TRUST_PROXY: undefined, GEMINI_FREE_TIER: true });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/SMTP_URL[\s\S]*TRUST_PROXY[\s\S]*GEMINI_FREE_TIER/);
  });
});
