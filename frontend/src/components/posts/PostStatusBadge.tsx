import type { PostStatus, TargetStatus } from "@/lib/posts";

const styles = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300",
  progress: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  success: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const labels: Record<PostStatus | TargetStatus, [string, keyof typeof styles]> = {
  DRAFT: ["Draft", "neutral"],
  SCHEDULED: ["Scheduled", "neutral"],
  QUEUED: ["Queued", "progress"],
  PUBLISHING: ["Publishing…", "progress"],
  WAITING_FOR_MEDIA: ["Processing video…", "progress"],
  PUBLISHED: ["Published", "success"],
  PARTIALLY_FAILED: ["Partly failed", "warning"],
  FAILED: ["Failed", "error"],
  CANCELLED: ["Cancelled", "neutral"],
};

export function PostStatusBadge({ status }: { status: PostStatus | TargetStatus }) {
  const [text, tone] = labels[status];
  return <span className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${styles[tone]}`}>{text}</span>;
}
