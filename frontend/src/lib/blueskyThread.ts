// Post length on Bluesky. A copy of the length rules in backend/src/integrations/bluesky/text.ts, so the
// composer previews exactly the posts the server will publish; keep the two in sync.
//
// From the app.bsky.feed.post lexicon: post text is at most 300 graphemes (what people see as
// characters) and 3000 UTF-8 bytes.
import { splitIntoThread } from "./textThread";

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
