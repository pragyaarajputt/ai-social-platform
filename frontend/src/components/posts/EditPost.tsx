"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { getPost, type Post } from "@/lib/posts";
import { Composer } from "./Composer";

/** Loads a scheduled post into the composer. Posts that have started publishing can't be edited. */
export function EditPost({ postId }: { postId: string }) {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    getPost(workspaceId, postId).then(
      (p) => active && setPost(p),
      (err: unknown) => active && setError(err instanceof ApiError ? err.message : "Couldn't load this post."),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, postId]);

  if (error) return <Notice>{error}</Notice>;
  if (!post) return <PageLoading />;
  if (post.status !== "SCHEDULED") {
    return (
      <Notice>
        Only scheduled posts can be edited, and this one has already started publishing or finished.{" "}
        <Link href={`/posts/${post.id}`} className="font-medium underline">
          Back to the post
        </Link>
      </Notice>
    );
  }
  return <Composer initialPost={post} />;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Alert tone="info">{children}</Alert>
    </div>
  );
}
