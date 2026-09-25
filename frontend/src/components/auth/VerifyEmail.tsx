"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";
import { reloadUser, verifyEmail } from "@/lib/auth";
import { AuthCard } from "./AuthCard";

type Result = { state: "pending" } | { state: "success" } | { state: "error"; message: string };

// Verification tokens are single-use. React dev mode runs effects twice, so share one request per token.
const requests = new Map<string, Promise<unknown>>();
function verifyOnce(token: string): Promise<unknown> {
  let request = requests.get(token);
  if (!request) {
    request = verifyEmail(token);
    requests.set(token, request);
  }
  return request;
}

export function VerifyEmail() {
  const token = useSearchParams().get("token");
  const { status, user } = useAuth();
  const [result, setResult] = useState<Result>({ state: "pending" });

  useEffect(() => {
    if (!token) return;
    let active = true;
    verifyOnce(token).then(
      () => active && setResult({ state: "success" }),
      (err: unknown) =>
        active &&
        setResult({
          state: "error",
          message: err instanceof ApiError ? err.message : "Something went wrong. Try again.",
        }),
    );
    return () => {
      active = false;
    };
  }, [token]);

  // Update the "verify your email" banner once the account is verified.
  useEffect(() => {
    if (result.state === "success" && status === "authenticated") void reloadUser().catch(() => {});
  }, [result.state, status]);

  if (!token) {
    return (
      <AuthCard title="Verify your email">
        <Alert tone="error">This verification link is incomplete. Open the link from your email again.</Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Verify your email">
      {result.state === "pending" ? (
        <p role="status" className="text-sm text-neutral-500">
          Verifying…
        </p>
      ) : result.state === "success" ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">Your email is verified.</Alert>
          <Link href="/" className="text-center text-sm font-medium hover:underline">
            Continue
          </Link>
        </div>
      ) : user?.emailVerified ? (
        // An old or reused link, but the account is verified already: nothing to fix.
        <div className="flex flex-col gap-4">
          <Alert tone="success">Your email is already verified.</Alert>
          <Link href="/" className="text-center text-sm font-medium hover:underline">
            Continue
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Alert tone="error">{result.message}</Alert>
          <p className="text-sm text-neutral-500">
            {status === "authenticated"
              ? "Use the “Resend link” button at the top of the page to get a new one."
              : "Log in to request a new verification link."}
          </p>
        </div>
      )}
    </AuthCard>
  );
}
