import type { Metadata } from "next";
import { PostList } from "@/components/posts/PostList";

export const metadata: Metadata = { title: "Posts" };

export default function PostsPage() {
  return <PostList />;
}
