import type { Metadata } from "next";
import { TeamSettings } from "@/components/workspace/TeamSettings";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage() {
  return <TeamSettings />;
}
