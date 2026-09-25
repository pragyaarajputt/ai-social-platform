import type { Metadata } from "next";
import { EditPost } from "@/components/posts/EditPost";

export const metadata: Metadata = { title: "Edit post" };

export default async function EditPostPage({ params }: PageProps<"/posts/[id]/edit">) {
  const { id } = await params;
  return <EditPost postId={id} />;
}
