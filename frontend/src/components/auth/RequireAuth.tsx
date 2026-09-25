"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

export function PageLoading() {
  return (
    <div role="status" className="flex flex-1 items-center justify-center py-24 text-sm text-neutral-500">
      Loading…
    </div>
  );
}

/**
 * Renders children only for signed-in users; sends everyone else to /login and back afterwards.
 * This is the only place that navigates after a sign-out, so pages don't redirect themselves.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unauthenticated") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  return status === "authenticated" ? children : <PageLoading />;
}

/**
 * For /login and /signup: signed-in users are sent on to `to`.
 * This is the only place that navigates after signing in, so the forms themselves don't redirect.
 */
export function RedirectIfAuthenticated({ to, children }: { to: string; children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") router.replace(to);
  }, [status, router, to]);

  return status === "unauthenticated" ? children : <PageLoading />;
}
