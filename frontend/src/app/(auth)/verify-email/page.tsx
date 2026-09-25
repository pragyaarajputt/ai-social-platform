import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { VerifyEmail } from "@/components/auth/VerifyEmail";

export const metadata: Metadata = { title: "Verify email" };

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <VerifyEmail />
    </Suspense>
  );
}
