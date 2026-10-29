import { describe, expect, it } from "vitest";
import { graphemeLength, splitThread as splitBlueskyThread } from "./blueskyThread";
import { accountLabel, blueskyFormat, blueskyProblems, formatLabel, xFormat, xProblems } from "./platforms";
import type { MediaItem } from "./posts";
import { splitThread, weightedLength, X_MAX_WEIGHT } from "./xThread";

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

// The splitting itself is tested in the backend (tests/x.test.ts) against the same code; these check
// the copy here behaves the same and the composer rules around it.
describe("X threads in the composer", () => {
  it("counts like X and splits long text into numbered posts that fit", () => {
    expect(weightedLength("🎉 https://example.com/a/very/long/path")).toBe(2 + 1 + 23);
    const text = Array.from({ length: 10 }, (_, i) => `Idea ${i + 1} is explained in this sentence about the product launch.`).join(" ");
    const posts = splitThread(text);
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((p, i) => weightedLength(p) <= X_MAX_WEIGHT && p.endsWith(` ${i + 1}/${posts.length}`))).toBe(true);
    expect(splitThread("One.\n---\nTwo.")).toEqual(["One. 1/2", "Two. 2/2"]);
  });

  it("allows up to 4 photos or one video, and at most 25 posts", () => {
    expect(xFormat([])).toBe("TEXT");
    expect(xFormat([media(), media()])).toBe("CAROUSEL");
    expect(xFormat([media(), media({ type: "VIDEO" })])).toBeNull();
    expect(xProblems("Gallery", Array.from({ length: 5 }, () => media()))).toEqual(["X posts can have at most 4 photos."]);
    expect(xProblems("", [])).toEqual(["Write something or add a photo or video."]);
    expect(xProblems("a".repeat(2000), [])).toEqual([]);
    expect(xProblems(Array.from({ length: 26 }, (_, i) => `Part ${i}.`).join("\n---\n"), [])[0]).toContain("at most 25");
  });

  it("names X accounts by handle and photo posts as multi-photo posts", () => {
    expect(accountLabel({ platform: "X", username: "pragya_builds", name: "Pragya" })).toBe("@pragya_builds");
    expect(formatLabel("CAROUSEL", "X")).toBe("Multi-photo post");
  });
});

describe("Bluesky threads in the composer", () => {
  it("counts what people see as characters and splits at 300", () => {
    expect(graphemeLength("👩🏽‍💻 hi")).toBe(4);
    const posts = splitBlueskyThread(Array.from({ length: 10 }, (_, i) => `Idea ${i + 1} is explained in this sentence about the product launch on Bluesky.`).join(" "));
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((p, i) => graphemeLength(p) <= 300 && p.endsWith(` ${i + 1}/${posts.length}`))).toBe(true);
  });

  it("allows up to 4 photos and no videos", () => {
    expect(blueskyFormat([media(), media()])).toBe("CAROUSEL");
    expect(blueskyFormat([media({ type: "VIDEO" })])).toBeNull();
    expect(blueskyProblems("Clip", [media({ type: "VIDEO" })])[0]).toContain("Videos can't be posted to Bluesky");
    expect(blueskyProblems("Gallery", Array.from({ length: 5 }, () => media()))).toEqual(["Bluesky posts can have at most 4 photos."]);
    expect(blueskyProblems("a ".repeat(400), [])).toEqual([]);
    expect(accountLabel({ platform: "BLUESKY", username: "pragya.bsky.social", name: "Pragya" })).toBe("@pragya.bsky.social");
  });
});
