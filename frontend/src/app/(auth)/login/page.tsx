import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/LoginForm";
import { PageLoading } from "@/components/auth/RequireAuth";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <LoginForm />
    </Suspense>
  );
}
