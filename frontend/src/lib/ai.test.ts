import { describe, expect, it } from "vitest";
import { addHashtags, captionHasTag, diffWords } from "./ai";

describe("addHashtags", () => {
  it("adds hashtags as a new paragraph after the text", () => {
    expect(addHashtags("New menu!", ["autumn", "coffee"])).toEqual({ caption: "New menu!\n\n#autumn #coffee", added: ["autumn", "coffee"], skipped: [] });
  });

  it("continues an existing line of hashtags, and works on an empty caption", () => {
    expect(addHashtags("Hi\n\n#one #two\n", ["three"]).caption).toBe("Hi\n\n#one #two #three");
    expect(addHashtags("", ["one"]).caption).toBe("#one");
  });

  it("skips hashtags the caption already has, in any letter case, and duplicates in the list", () => {
    const result = addHashtags("Great #Coffee here", ["coffee", "latte", "Latte"]);
    expect(result.added).toEqual(["latte"]);
    expect(result.skipped).toEqual(["coffee", "Latte"]);
    // #coffee doesn't count as already having #cof.
    expect(addHashtags("#coffee", ["cof"]).added).toEqual(["cof"]);
  });

  it("never goes past 30 hashtags", () => {
    const caption = Array.from({ length: 29 }, (_, i) => `#t${i}`).join(" ");
    const result = addHashtags(caption, ["a1", "b2", "c3"]);
    expect(result.added).toEqual(["a1"]);
    expect(result.skipped).toEqual(["b2", "c3"]);
    expect(addHashtags(`${caption} #full`, ["x1"]).caption).toBe(`${caption} #full`);
  });

  it("detects tags with unicode letters", () => {
    expect(captionHasTag("Lovely #café", "Café")).toBe(true);
    expect(captionHasTag("Lovely #cafés", "café")).toBe(false);
  });
});

describe("diffWords", () => {
  it("marks removed and added words, keeping the unchanged ones", () => {
    expect(diffWords("the quick fox", "the slow fox")).toEqual([
      { text: "the ", change: "same" },
      { text: "quick", change: "removed" },
      { text: "slow", change: "added" },
      { text: " fox", change: "same" },
    ]);
  });

  it("rebuilds both texts exactly", () => {
    const before = "Come try our new menu!\nOpen daily.";
    const after = "Try our brand new autumn menu 🍂\nOpen every day.";
    const parts = diffWords(before, after);
    expect(parts.filter((p) => p.change !== "added").map((p) => p.text).join("")).toBe(before);
    expect(parts.filter((p) => p.change !== "removed").map((p) => p.text).join("")).toBe(after);
  });
});
