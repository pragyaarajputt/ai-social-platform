import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <SignupForm />
    </Suspense>
  );
}
