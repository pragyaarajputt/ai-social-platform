import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { PageLoading } from "@/components/auth/RequireAuth";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
