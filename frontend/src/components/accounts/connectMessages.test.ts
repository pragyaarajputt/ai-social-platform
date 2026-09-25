import { describe, expect, it } from "vitest";
import { connectResultMessage, platformDisplayName } from "./connectMessages";

const msg = (query: string) => connectResultMessage(new URLSearchParams(query), platformDisplayName);

describe("connectResultMessage()", () => {
  it("returns nothing without a result in the URL", () => {
    expect(msg("")).toBeNull();
  });

  it("confirms a successful connection", () => {
    expect(msg("connected=instagram")).toEqual({ tone: "success", text: "Instagram account connected." });
  });

  it("explains how to fix a personal Instagram account", () => {
    const m = msg("error=unsupported_account&platform=instagram");
    expect(m?.tone).toBe("error");
    expect(m?.text).toContain("Business or Creator");
    expect(m?.text).toContain("Switch to professional account");
  });

  it("covers cancelled, expired and unknown errors", () => {
    expect(msg("error=cancelled&platform=instagram")?.text).toContain("cancelled");
    expect(msg("error=invalid_state&platform=instagram")?.text).toContain("expired");
    expect(msg("error=something_new&platform=instagram")?.text).toContain("returned an error");
  });
});
