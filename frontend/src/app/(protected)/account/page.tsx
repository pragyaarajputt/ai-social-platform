import type { Metadata } from "next";
import { AccountPanel } from "@/components/auth/AccountPanel";

export const metadata: Metadata = { title: "Account" };

export default function AccountPage() {
  return <AccountPanel />;
}
