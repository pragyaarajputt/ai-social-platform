import { describe, expect, it } from "vitest";
import { countHashtags, countMentions, instagramFormat, instagramProblems } from "./instagramRules";
import type { MediaItem } from "./posts";

const media = (m: Partial<MediaItem> = {}): MediaItem => ({
  id: "m",
  type: "IMAGE",
  format: "jpg",
  bytes: 1000,
  width: 1080,
  height: 1080,
  durationSec: null,
  url: "",
  thumbnailUrl: "",
  createdAt: "",
  ...m,
});

describe("instagramFormat()", () => {
  it("picks image, reel or carousel from the media", () => {
    expect(instagramFormat([])).toBeNull();
    expect(instagramFormat([media()])).toBe("IMAGE");
    expect(instagramFormat([media({ type: "VIDEO" })])).toBe("REEL");
    expect(instagramFormat([media(), media({ type: "VIDEO" })])).toBe("CAROUSEL");
  });
});

describe("instagramProblems()", () => {
  it("accepts a normal square image post", () => {
    expect(instagramProblems("Hello #launch @friend", [media()])).toEqual([]);
  });

  it("flags aspect ratios outside 4:5 to 1.91:1, and allows the exact limits", () => {
    expect(instagramProblems("", [media({ width: 1080, height: 1920 })])[0]).toContain("aspect ratio");
    expect(instagramProblems("", [media({ width: 1080, height: 1350 })])).toEqual([]); // 4:5
    expect(instagramProblems("", [media({ width: 1910, height: 1000 })])).toEqual([]); // 1.91:1
  });

  it("counts hashtags and mentions like Instagram, and enforces the limits", () => {
    expect(countHashtags("#a b#notatag #c_d #日本")).toBe(3);
    expect(countMentions("@a email@example.com @b.c")).toBe(2);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(instagramProblems(tags, [media()])).toEqual(["Use at most 30 hashtags."]);
  });

  it("checks video length and needs at least one media item", () => {
    expect(instagramProblems("", [media({ type: "VIDEO", durationSec: 2 })])[0]).toContain("3 s to 15 minutes");
    expect(instagramProblems("text only", [])).toEqual(["Add at least one photo or video."]);
  });
});
