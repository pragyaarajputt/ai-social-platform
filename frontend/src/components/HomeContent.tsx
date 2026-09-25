"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { Dashboard } from "./Dashboard";
import { PageLoading } from "./auth/RequireAuth";

export function HomeContent() {
  const { status } = useAuth();

  if (status === "loading") return <PageLoading />;
  if (status === "authenticated") return <Dashboard />;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-24 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">All your social accounts, one place.</h1>
      <p className="max-w-md text-neutral-500">
        Connect Instagram and more, write posts with AI help, and publish or schedule them everywhere at once.
      </p>
      <div className="flex gap-3">
        <Link
          href="/signup"
          className="inline-flex h-10 items-center rounded-lg bg-foreground px-5 text-sm font-medium text-background"
        >
          Create an account
        </Link>
        <Link
          href="/login"
          className="inline-flex h-10 items-center rounded-lg border border-neutral-300 px-5 text-sm font-medium dark:border-neutral-700"
        >
          Log in
        </Link>
      </div>
    </div>
  );
}
