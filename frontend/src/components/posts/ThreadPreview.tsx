import { BLUESKY_MAX_GRAPHEMES, BLUESKY_THREAD_MAX_POSTS, graphemeLength, splitThread as splitBlueskyThread } from "@/lib/blueskyThread";
import { platformName } from "@/lib/platforms";
import { splitThread as splitXThread, weightedLength, X_MAX_WEIGHT, X_THREAD_MAX_POSTS } from "@/lib/xThread";

/** Platforms with short posts, where long text becomes a thread. */
export type ThreadPlatform = "X" | "BLUESKY";
export const THREAD_PLATFORMS: ThreadPlatform[] = ["X", "BLUESKY"];

const RULES: Record<ThreadPlatform, { split(text: string): string[]; measure(text: string): number; max: number; maxPosts: number }> = {
  X: { split: splitXThread, measure: weightedLength, max: X_MAX_WEIGHT, maxPosts: X_THREAD_MAX_POSTS },
  BLUESKY: { split: splitBlueskyThread, measure: graphemeLength, max: BLUESKY_MAX_GRAPHEMES, maxPosts: BLUESKY_THREAD_MAX_POSTS },
};

/**
 * What the text becomes on X or Bluesky: one post with its length, or, for longer text, the thread of
 * posts the server will publish (same splitting code), so nothing about it is a surprise.
 */
export function ThreadPreview({ platform, text }: { platform: ThreadPlatform; text: string }) {
  const rules = RULES[platform];
  const name = platformName(platform);
  const posts = rules.split(text);
  if (posts.length === 0) return null;
  if (posts.length === 1) {
    const n = rules.measure(posts[0]!);
    return (
      <p className="mt-1 text-xs text-neutral-500">
        {name}: <span className={n > rules.max ? "font-medium text-red-600 dark:text-red-400" : undefined}>{n} / {rules.max}</span> characters. Longer text
        is posted as a thread; put <code>---</code> on its own line to choose where posts break.
      </p>
    );
  }

  const tooMany = posts.length > rules.maxPosts;
  return (
    <details className="mt-2 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800" open={posts.length <= 4}>
      <summary className="cursor-pointer text-xs font-medium">
        On {name} this is a thread of {posts.length} posts
        {tooMany ? <span className="text-red-600 dark:text-red-400"> (at most {rules.maxPosts})</span> : null}
      </summary>
      <p className="mt-1 text-xs text-neutral-500">
        Each post replies to the one before it. Photos{platform === "X" ? " or a video" : ""} go on the first post. Put <code>---</code> on its own line to
        choose where posts break.
      </p>
      <ol className="mt-2 flex flex-col gap-2">
        {posts.map((p, i) => {
          const n = rules.measure(p);
          return (
            <li key={i} className="rounded-lg bg-neutral-50 p-2 dark:bg-neutral-900">
              <p className="whitespace-pre-wrap break-words text-xs">{p}</p>
              <p className={`mt-1 text-right text-[11px] ${n > rules.max ? "font-medium text-red-600 dark:text-red-400" : "text-neutral-500"}`}>
                {n} / {rules.max}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
