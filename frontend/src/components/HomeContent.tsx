"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { PageLoading } from "./auth/RequireAuth";

export function HomeContent() {
  const { status, user } = useAuth();

  if (status === "loading") return <PageLoading />;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-24 text-center">
      {status === "authenticated" ? (
        <>
          <h1 className="text-3xl font-semibold">Hi, {user.displayName ?? user.username}</h1>
          <p className="text-neutral-500">
            Signed in as <span className="font-medium text-foreground">@{user.username}</span>. Your feed is coming soon.
          </p>
          <Link href="/account" className="text-sm font-medium hover:underline">
            Go to your account
          </Link>
        </>
      ) : (
        <>
          <h1 className="text-4xl font-semibold tracking-tight">Post better, with AI built in.</h1>
          <p className="max-w-md text-neutral-500">
            Captions, hashtags and whole posts written with you, plus a summary of what you missed.
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
        </>
      )}
    </div>
  );
}
