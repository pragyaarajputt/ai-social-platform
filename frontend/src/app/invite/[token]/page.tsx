import type { Metadata } from "next";
import { InviteView } from "@/components/workspace/InviteView";

export const metadata: Metadata = { title: "Invitation" };

// Not in the (protected) group: people open invites before they have an account.
export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  return <InviteView token={token} />;
}
