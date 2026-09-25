"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { initSession } from "@/lib/auth";
import { PageLoading } from "./RequireAuth";

/** Google sign-in lands here with a fresh refresh cookie; exchange it for a session, then go home. */
export function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    void initSession().then((result) => {
      router.replace(result ? "/" : "/login?error=oauth_failed");
    });
  }, [router]);

  return <PageLoading />;
}
