"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { listSocialAccounts, type SocialAccount } from "@/lib/workspaces";
import { PageLoading } from "./auth/RequireAuth";

/** The signed-in home page. Grows into scheduled/published posts once the composer exists. */
export function Dashboard() {
  const { user } = useAuth();
  const { workspace, status } = useWorkspace();
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const workspaceId = workspace?.id;

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    listSocialAccounts(workspaceId).then(
      (data) => active && setAccounts(data.accounts),
      () => active && setAccounts([]),
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (status === "loading" || (status === "ready" && accounts === null)) return <PageLoading />;

  const needsAttention = accounts?.filter((a) => a.status !== "ACTIVE") ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Hi, {user?.displayName ?? user?.username}</h1>
      <p className="mt-1 text-sm text-neutral-500">{workspace?.name}</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          href="/accounts"
          className="rounded-2xl border border-neutral-200 p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
        >
          <p className="text-sm text-neutral-500">Connected accounts</p>
          <p className="mt-1 text-3xl font-semibold">{accounts?.length ?? 0}</p>
          <p className="mt-2 text-sm">
            {accounts?.length ? "Manage accounts →" : "Connect your first account →"}
          </p>
        </Link>
        <div className="rounded-2xl border border-dashed border-neutral-300 p-5 dark:border-neutral-700">
          <p className="text-sm text-neutral-500">Posts</p>
          <p className="mt-1 font-medium">Create and schedule posts</p>
          <p className="mt-2 text-sm text-neutral-500">Coming next.</p>
        </div>
      </div>

      {needsAttention.length > 0 ? (
        <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {needsAttention.length === 1 ? "1 account needs" : `${needsAttention.length} accounts need`} attention.{" "}
          <Link href="/accounts" className="font-medium underline">
            Review
          </Link>
        </p>
      ) : null}
    </div>
  );
}
