"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";
import { resendVerification } from "@/lib/auth";

export function VerifyEmailBanner() {
  const { status, user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (status !== "authenticated" || user.emailVerified) return null;

  async function resend() {
    setSending(true);
    try {
      await resendVerification();
      setMessage(`Sent. Check ${user?.email}.`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Couldn't send the email. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      Please verify your email address.{" "}
      {message ? (
        <span>{message}</span>
      ) : (
        <button type="button" onClick={resend} disabled={sending} className="font-medium underline disabled:opacity-60">
          {sending ? "Sending…" : "Resend link"}
        </button>
      )}
    </div>
  );
}
