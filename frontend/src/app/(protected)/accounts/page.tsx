import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountsPanel } from "@/components/accounts/AccountsPanel";
import { PageLoading } from "@/components/auth/RequireAuth";

export const metadata: Metadata = { title: "Connected accounts" };

export default function AccountsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AccountsPanel />
    </Suspense>
  );
}
