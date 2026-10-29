// Post length and rich text on Bluesky. The length rules are mirrored in frontend/src/lib/blueskyThread.ts
// so the composer previews exactly the posts that will be published; keep the two in sync.
//
// From the app.bsky.feed.post and app.bsky.richtext.facet lexicons (checked 2026-10-29,
// github.com/bluesky-social/bsky/tree/main/lexicons): post text is at most 300 graphemes (what people
// see as characters) and 3000 UTF-8 bytes. Links, mentions and hashtags aren't detected from the text
// by Bluesky: the post carries "facets" that mark them, by UTF-8 byte offsets.
import { splitIntoThread } from "../textThread.js";

export const BLUESKY_MAX_GRAPHEMES = 300;
export const BLUESKY_MAX_BYTES = 3000;
/** How many posts one thread may have here. */
export const BLUESKY_THREAD_MAX_POSTS = 25;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const encoder = new TextEncoder();

export const graphemeLength = (text: string) => [...graphemes.segment(text)].length;

export const byteLength = (text: string) => encoder.encode(text).length;

/** The posts this text becomes on Bluesky (see splitIntoThread). Returns [] for empty text. */
export function splitThread(text: string): string[] {
  return splitIntoThread(text, { maxLength: BLUESKY_MAX_GRAPHEMES, measure: graphemeLength });
}

// ─── Facets ─────────────────────────────────────────────────────────────────

export type Facet = {
  index: { byteStart: number; byteEnd: number };
  features: ({ $type: "app.bsky.richtext.facet#link"; uri: string } | { $type: "app.bsky.richtext.facet#mention"; did: string } | { $type: "app.bsky.richtext.facet#tag"; tag: string })[];
};

// Trailing punctuation usually ends the sentence, not the link.
const LINK = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)'\]]/gu;
const MENTION = /(?<=^|[\s(])@([a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})\b/gu;
const TAG = /(?<=^|\s)#([^\s#.,;:!?()[\]{}"'<>]*[^\d\s#.,;:!?()[\]{}"'<>][^\s#.,;:!?()[\]{}"'<>]*)/gu;

const slice = (text: string, start: number, end: number) => ({
  byteStart: byteLength(text.slice(0, start)),
  byteEnd: byteLength(text.slice(0, end)),
});

/**
 * Links, @mentions and #hashtags in the text, as facets. Mentions need the account's DID: `resolveHandle`
 * looks it up, and a handle that doesn't resolve stays plain text (as in the Bluesky app).
 */
export async function detectFacets(text: string, resolveHandle: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const facets: Facet[] = [];
  for (const m of text.matchAll(LINK)) {
    facets.push({ index: slice(text, m.index, m.index + m[0].length), features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  for (const m of text.matchAll(MENTION)) {
    const did = await resolveHandle(m[1]!.toLowerCase());
    if (did) facets.push({ index: slice(text, m.index, m.index + m[0].length), features: [{ $type: "app.bsky.richtext.facet#mention", did }] });
  }
  for (const m of text.matchAll(TAG)) {
    const tag = m[1]!;
    if (graphemeLength(tag) > 64) continue;
    facets.push({ index: slice(text, m.index, m.index + m[0].length), features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
