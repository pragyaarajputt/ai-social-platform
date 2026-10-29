// Splitting long text into a thread of posts, for platforms with short posts (X, Bluesky). Each platform
// supplies how it measures a post and the limit. Mirrored in frontend/src/lib/textThread.ts so the
// composer previews exactly the posts that will be published; keep the two in sync.

export interface ThreadRules {
  /** Longest post, in the platform's own units. */
  maxLength: number;
  /** The platform's length of a piece of text. */
  measure(text: string): number;
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A line with only "---" on it starts a new post in the thread. */
const SEPARATOR = /^[ \t]*-{3,}[ \t]*$/m;
/** Room kept at the end of each thread post for its " 12/25" counter. */
const COUNTER_RESERVE = 6;

/**
 * The posts this text becomes. Text that fits in one post stays one post. Otherwise it becomes a
 * thread: the author's own "---" lines split it first, then any part that's still too long is split at
 * a paragraph or sentence end (or, failing that, between words), and each post gets a " 1/3" counter.
 * Returns [] for empty text.
 */
export function splitIntoThread(text: string, rules: ThreadRules): string[] {
  const sections = text
    .replace(/\r\n?/g, "\n")
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sections.length === 0) return [];
  if (sections.length === 1 && rules.measure(sections[0]!) <= rules.maxLength) return sections;

  const budget = rules.maxLength - COUNTER_RESERVE;
  const posts = sections.flatMap((s) => pack(s, budget, rules.measure));
  return posts.map((p, i) => `${p} ${i + 1}/${posts.length}`);
}

function pack(text: string, budget: number, measure: (s: string) => number): string[] {
  const posts: string[] = [];
  let rest = text;
  while (measure(rest) > budget) {
    const cut = cutPoint(rest, budget, measure);
    posts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) posts.push(rest);
  return posts;
}

/** Where to end the next post: as late as fits, preferring a paragraph or sentence end. */
function cutPoint(text: string, budget: number, measure: (s: string) => number): number {
  let end = 0;
  let preferred = 0;
  for (const word of text.match(/\S+\s*/g) ?? []) {
    const next = end + word.length;
    if (measure(text.slice(0, next).trimEnd()) > budget) break;
    end = next;
    if (/\n\s*$/.test(word) || /[.!?…]["'”’)\]]*\s+$/.test(word)) preferred = end;
  }
  if (end === 0) return hardCut(text, budget, measure);
  // A sentence end is only worth it if it doesn't leave the post less than half full.
  if (preferred > 0 && measure(text.slice(0, preferred)) >= budget / 2) return preferred;
  return end;
}

/** A single "word" longer than a post (no spaces to break at): cut it between characters. */
function hardCut(text: string, budget: number, measure: (s: string) => number): number {
  let end = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (measure(text.slice(0, end + segment.length)) > budget) break;
    end += segment.length;
  }
  return Math.max(end, 1);
}
