import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { PostList } from "@/components/posts/PostList";

export const metadata: Metadata = { title: "Posts" };

export default function PostsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PostList />
    </Suspense>
  );
}
