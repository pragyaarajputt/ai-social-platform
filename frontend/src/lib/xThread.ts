// Post length on X, and splitting long text into an X thread. A copy of
// backend/src/integrations/x/text.ts, so the composer previews exactly the posts the server will publish.
//
// X counts "weighted" characters, at most 280 per post (https://docs.x.com/fundamentals/counting-characters):
// Latin letters, punctuation and common symbols weigh 1; emoji, CJK and other scripts weigh 2; every
// URL weighs 23 whatever its length. The code point ranges below are those of the twitter-text library's
// v3 configuration. X does the final check when a post is created.
import { splitIntoThread } from "./textThread";

export const X_MAX_WEIGHT = 280;
/** How many posts one thread may have here. */
export const X_THREAD_MAX_POSTS = 25;

const URL_WEIGHT = 23;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;
const LIGHT_RANGES: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const EMOJI = /\p{Extended_Pictographic}/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function weightedLength(text: string): number {
  const s = text.normalize("NFC");
  let total = 0;
  let last = 0;
  for (const m of s.matchAll(URL)) {
    total += weighText(s.slice(last, m.index)) + URL_WEIGHT;
    last = m.index + m[0].length;
  }
  return total + weighText(s.slice(last));
}

function weighText(s: string): number {
  let weight = 0;
  for (const { segment } of graphemes.segment(s)) {
    // An emoji counts 2 however many code points it's made of (skin tones, ZWJ sequences).
    if (EMOJI.test(segment)) {
      weight += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      weight += LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
    }
  }
  return weight;
}

/** The posts this text becomes on X (see splitIntoThread). Returns [] for empty text. */
export function splitThread(text: string): string[] {
  return splitIntoThread(text, { maxLength: X_MAX_WEIGHT, measure: weightedLength });
}
