// Post length on X, and splitting long text into a thread. A copy of backend/src/integrations/x/text.ts,
// so the composer previews exactly the posts the server will publish; keep the two in sync.
//
// X counts "weighted" characters, at most 280 per post (https://docs.x.com/fundamentals/counting-characters):
// Latin letters, punctuation and common symbols weigh 1; emoji, CJK and other scripts weigh 2; every
// URL weighs 23 whatever its length. The code point ranges below are those of the twitter-text library's
// v3 configuration. X does the final check when a post is created.

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

/** A line with only "---" on it starts a new post in the thread. */
const SEPARATOR = /^[ \t]*-{3,}[ \t]*$/m;
/** Room kept at the end of each thread post for its " 12/25" counter. */
const COUNTER_RESERVE = 6;

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

/**
 * The posts this text becomes on X. Text that fits in one post stays one post. Otherwise it becomes a
 * thread: the author's own "---" lines split it first, then any part that's still too long is split at
 * a paragraph or sentence end (or, failing that, between words), and each post gets a " 1/3" counter.
 * Returns [] for empty text.
 */
export function splitThread(text: string): string[] {
  const sections = text
    .replace(/\r\n?/g, "\n")
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sections.length === 0) return [];
  if (sections.length === 1 && weightedLength(sections[0]!) <= X_MAX_WEIGHT) return sections;

  const posts = sections.flatMap((s) => pack(s, X_MAX_WEIGHT - COUNTER_RESERVE));
  return posts.map((p, i) => `${p} ${i + 1}/${posts.length}`);
}

function pack(text: string, budget: number): string[] {
  const posts: string[] = [];
  let rest = text;
  while (weightedLength(rest) > budget) {
    const cut = cutPoint(rest, budget);
    posts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) posts.push(rest);
  return posts;
}

/** Where to end the next post: as late as fits, preferring a paragraph or sentence end. */
function cutPoint(text: string, budget: number): number {
  let end = 0;
  let preferred = 0;
  for (const word of text.match(/\S+\s*/g) ?? []) {
    const next = end + word.length;
    if (weightedLength(text.slice(0, next).trimEnd()) > budget) break;
    end = next;
    if (/\n\s*$/.test(word) || /[.!?…]["'”’)\]]*\s+$/.test(word)) preferred = end;
  }
  if (end === 0) return hardCut(text, budget);
  // A sentence end is only worth it if it doesn't leave the post less than half full.
  if (preferred > 0 && weightedLength(text.slice(0, preferred)) >= budget / 2) return preferred;
  return end;
}

/** A single "word" longer than a post (no spaces to break at): cut it between characters. */
function hardCut(text: string, budget: number): number {
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (weightedLength(text.slice(0, end + segment.length)) > budget) break;
    end += segment.length;
  }
  return Math.max(end, 1);
}
