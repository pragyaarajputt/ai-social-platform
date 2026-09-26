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

  it("counts connected Facebook Pages", () => {
    expect(msg("connected=facebook&count=1")?.text).toBe("Facebook Page connected.");
    expect(msg("connected=facebook&count=3")?.text).toBe("3 Facebook Pages connected.");
  });

  it("explains accounts already connected to another workspace", () => {
    expect(msg("error=connected_elsewhere&platform=instagram")?.text).toContain("already connected to another workspace");
    expect(msg("connected=facebook&count=2&elsewhere=1")?.text).toBe(
      "2 Facebook Pages connected. 1 more is already connected to another workspace; disconnect it there to connect it here.",
    );
  });

  it("explains what to do when no Page could be connected", () => {
    expect(msg("error=no_accounts&platform=facebook")?.text).toContain("choose at least one Page");
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
