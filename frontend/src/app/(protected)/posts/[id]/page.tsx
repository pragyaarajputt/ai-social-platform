import type { Metadata } from "next";
import { PostDetail } from "@/components/posts/PostDetail";

export const metadata: Metadata = { title: "Post" };

export default async function PostPage({ params }: PageProps<"/posts/[id]">) {
  const { id } = await params;
  return <PostDetail postId={id} />;
}
