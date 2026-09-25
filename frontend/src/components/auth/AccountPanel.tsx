"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/components/auth/AuthProvider";
import { logout, logoutAllDevices } from "@/lib/auth";

export function AccountPanel() {
  const { user } = useAuth();
  const [pending, setPending] = useState<"logout" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null; // RequireAuth guarantees a user; this satisfies the type checker.

  async function run(kind: "logout" | "all") {
    setPending(kind);
    setError(null);
    try {
      await (kind === "all" ? logoutAllDevices() : logout()); // RequireAuth navigates to /login
    } catch {
      // The local session is cleared either way; only the server call failed.
      setError("You're signed out here, but we couldn't reach the server. Other devices may still be signed in.");
      setPending(null);
    }
  }

  const rows: [string, string][] = [
    ["Display name", user.displayName ?? "—"],
    ["Username", `@${user.username}`],
    ["Email", user.email],
    ["Email status", user.emailVerified ? "Verified" : "Not verified"],
    ["Member since", new Date(user.createdAt).toLocaleDateString()],
  ];

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-10">
      <h1 className="text-2xl font-semibold">Account</h1>
      <dl className="mt-6 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 px-4 py-3 text-sm">
            <dt className="text-neutral-500">{label}</dt>
            <dd className="text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 text-sm">
        <Link href="/settings/brand-voice" className="font-medium underline">
          Brand voice
        </Link>{" "}
        <span className="text-neutral-500">· how AI suggestions should sound</span>
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button variant="secondary" loading={pending === "logout"} disabled={pending !== null} onClick={() => run("logout")}>
          Log out
        </Button>
        <Button variant="danger" loading={pending === "all"} disabled={pending !== null} onClick={() => run("all")}>
          Log out of all devices
        </Button>
      </div>
    </div>
  );
}
