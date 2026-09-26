"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";

export function SiteHeader() {
  const { status, user } = useAuth();

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <nav className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
        <Link href="/" className="font-semibold">
          AI Social
        </Link>
        {/* Wraps onto a second line on narrow screens rather than scrolling sideways. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:gap-x-4">
          {status === "authenticated" ? (
            <>
              <Link href="/" className="hover:underline">
                Dashboard
              </Link>
              <Link href="/posts" className="hover:underline">
                Posts
              </Link>
              <Link href="/calendar" className="hover:underline">
                Calendar
              </Link>
              <Link href="/analytics" className="hover:underline">
                Analytics
              </Link>
              <Link href="/accounts" className="hover:underline">
                Accounts
              </Link>
              <Link href="/account" className="text-neutral-500 hover:underline">
                @{user.username}
              </Link>
            </>
          ) : status === "unauthenticated" ? (
            <>
              <Link href="/login" className="hover:underline">
                Log in
              </Link>
              <Link href="/signup" className="rounded-lg bg-foreground px-3 py-1.5 font-medium text-background">
                Sign up
              </Link>
            </>
          ) : null}
        </div>
      </nav>
    </header>
  );
}
