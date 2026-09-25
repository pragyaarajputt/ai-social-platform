"use client";

import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";

export function SiteHeader() {
  const { status, user } = useAuth();

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="font-semibold">
          AI Social
        </Link>
        <div className="flex items-center gap-4 text-sm">
          {status === "authenticated" ? (
            <>
              <Link href="/" className="hover:underline">
                Dashboard
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
