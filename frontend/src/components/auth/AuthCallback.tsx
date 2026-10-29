"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { initSession, safeNextPath } from "@/lib/auth";
import { PageLoading } from "./RequireAuth";

/**
 * Google sign-in lands here with a fresh refresh cookie; exchange it for a session, then go where the
 * person was headed (e.g. an invite), or home.
 */
export function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    // Read directly rather than with useSearchParams, so this page needs no Suspense boundary.
    const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    void initSession().then((result) => {
      router.replace(result ? next : "/login?error=oauth_failed");
    });
  }, [router]);

  return <PageLoading />;
}
