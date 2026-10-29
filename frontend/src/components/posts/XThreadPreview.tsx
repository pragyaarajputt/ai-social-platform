import { splitThread, weightedLength, X_MAX_WEIGHT, X_THREAD_MAX_POSTS } from "@/lib/xThread";

/**
 * What the text becomes on X: one post with its length, or, for longer text, the thread of posts the
 * server will publish (same splitting code), so nothing about it is a surprise.
 */
export function XThreadPreview({ text }: { text: string }) {
  const posts = splitThread(text);
  if (posts.length === 0) return null;
  if (posts.length === 1) {
    const n = weightedLength(posts[0]!);
    return (
      <p className="mt-1 text-xs text-neutral-500">
        X: <span className={n > X_MAX_WEIGHT ? "font-medium text-red-600 dark:text-red-400" : undefined}>{n} / {X_MAX_WEIGHT}</span> characters. Longer text is
        posted as a thread; put <code>---</code> on its own line to choose where posts break.
      </p>
    );
  }

  const tooMany = posts.length > X_THREAD_MAX_POSTS;
  return (
    <details className="mt-2 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800" open={posts.length <= 4}>
      <summary className="cursor-pointer text-xs font-medium">
        On X this is a thread of {posts.length} posts
        {tooMany ? <span className="text-red-600 dark:text-red-400"> (at most {X_THREAD_MAX_POSTS})</span> : null}
      </summary>
      <p className="mt-1 text-xs text-neutral-500">Each post replies to the one before it. Photos or a video go on the first post. Put <code>---</code> on its own line to choose where posts break.</p>
      <ol className="mt-2 flex flex-col gap-2">
        {posts.map((p, i) => {
          const n = weightedLength(p);
          return (
            <li key={i} className="rounded-lg bg-neutral-50 p-2 dark:bg-neutral-900">
              <p className="whitespace-pre-wrap break-words text-xs">{p}</p>
              <p className={`mt-1 text-right text-[11px] ${n > X_MAX_WEIGHT ? "font-medium text-red-600 dark:text-red-400" : "text-neutral-500"}`}>
                {n} / {X_MAX_WEIGHT}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
