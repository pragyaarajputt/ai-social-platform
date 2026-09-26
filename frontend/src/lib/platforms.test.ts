import { describe, expect, it } from "vitest";
import { facebookFormat, facebookProblems, formatLabel, problemsFor } from "./platforms";
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

describe("facebookFormat()", () => {
  it("allows text-only posts, photos, and one video", () => {
    expect(facebookFormat([])).toBe("TEXT");
    expect(facebookFormat([media()])).toBe("IMAGE");
    expect(facebookFormat([media(), media()])).toBe("CAROUSEL");
    expect(facebookFormat([media(), media({ type: "VIDEO" })])).toBeNull();
  });

  it("makes short vertical videos Reels and everything else regular videos", () => {
    const vertical = { type: "VIDEO" as const, width: 1080, height: 1920 };
    expect(facebookFormat([media({ ...vertical, durationSec: 30 })])).toBe("REEL");
    expect(facebookFormat([media({ ...vertical, durationSec: 91 })])).toBe("VIDEO");
    expect(facebookFormat([media({ ...vertical, durationSec: 2 })])).toBe("VIDEO");
    expect(facebookFormat([media({ type: "VIDEO", width: 1920, height: 1080, durationSec: 30 })])).toBe("VIDEO");
    expect(facebookFormat([media({ type: "VIDEO", width: 480, height: 854, durationSec: 30 })])).toBe("VIDEO"); // too small
    expect(facebookFormat([media({ ...vertical, durationSec: null })])).toBe("VIDEO");
  });
});

describe("problems per platform", () => {
  it("a text-only post is fine on Facebook but not on Instagram", () => {
    expect(problemsFor("FACEBOOK", "Open late tonight", [])).toEqual([]);
    expect(problemsFor("INSTAGRAM", "Open late tonight", [])).toEqual(["Add at least one photo or video."]);
    expect(facebookProblems("  ", [])).toEqual(["Write something or add a photo or video."]);
  });

  it("uses each platform's text limit", () => {
    const long = "x".repeat(3000);
    expect(problemsFor("FACEBOOK", long, [media()])).toEqual([]);
    expect(problemsFor("INSTAGRAM", long, [media()])[0]).toContain("2200");
    expect(facebookProblems("x".repeat(63_207), [])[0]).toContain("63,206");
  });

  it("rejects photos and a video together on Facebook only", () => {
    const mixed = [media(), media({ type: "VIDEO", durationSec: 10 })];
    expect(facebookProblems("", mixed)).toEqual(["Facebook posts can have several photos or one video, not both."]);
    expect(problemsFor("INSTAGRAM", "", mixed)).toEqual([]);
  });

  it("names formats the way each platform does", () => {
    expect(formatLabel("CAROUSEL", "FACEBOOK")).toBe("Multi-photo post");
    expect(formatLabel("CAROUSEL", "INSTAGRAM")).toBe("Carousel");
    expect(formatLabel("TEXT", "FACEBOOK")).toBe("Text post");
  });
});
