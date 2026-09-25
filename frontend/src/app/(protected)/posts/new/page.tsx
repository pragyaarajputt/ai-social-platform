import type { Metadata } from "next";
import { Composer } from "@/components/posts/Composer";

export const metadata: Metadata = { title: "Create post" };

export default function NewPostPage() {
  return <Composer />;
}
