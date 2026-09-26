"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ApiError } from "@/lib/api";
import { logout, resendVerification } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { acceptInvite, previewInvite, ROLE_DESCRIPTIONS, ROLE_LABELS, type InvitePreview } from "@/lib/team";
import { rememberWorkspace, useWorkspace } from "./WorkspaceProvider";

const STATE_MESSAGES: Record<Exclude<InvitePreview["state"], "pending">, string> = {
  expired: "This invite has expired. Ask whoever invited you to send a new one.",
  revoked: "This invite was withdrawn. Ask whoever invited you for a new one.",
  accepted: "This invite has already been used.",
};

/** /invite/[token]: what the invite is for, and accepting it (through sign-up or login if needed). */
export function InviteView({ token }: { token: string }) {
  const { status, user } = useAuth();
  const { reload } = useWorkspace();
  const router = useRouter();
  const [invite, setInvite] = useState<InvitePreview | null | "invalid">(null);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    let active = true;
    previewInvite(token).then(
      (i) => active && setInvite(i),
      () => active && setInvite("invalid"),
    );
    return () => {
      active = false;
    };
  }, [token]);

  if (invite === null || status === "loading") return <PageLoading />;
  const here = `/invite/${encodeURIComponent(token)}`;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const { workspaceId } = await acceptInvite(token);
      rememberWorkspace(user!.id, workspaceId);
      reload(workspaceId);
      router.push("/");
    } catch (err) {
      setError(err instanceof ApiError ? { code: err.code, text: err.message } : { code: "", text: "Couldn't accept the invite. Try again." });
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <div className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
        {invite === "invalid" ? (
          <>
            <h1 className="text-xl font-semibold">Invite not found</h1>
            <p className="mt-2 text-sm text-neutral-500">This invite link isn&apos;t valid. It may have been replaced by a newer one; check your latest invite email.</p>
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-500">{invite.inviterName} invited you to</p>
            <h1 className="mt-1 text-2xl font-semibold">{invite.workspaceName}</h1>
            <p className="mt-3 text-sm">
              as <strong>{ROLE_LABELS[invite.role]}</strong>
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{ROLE_DESCRIPTIONS[invite.role]}.</p>
            <p className="mt-1 text-xs text-neutral-500">
              For {invite.email} · expires {formatDateTime(new Date(invite.expiresAt))}
            </p>

            <div className="mt-6 flex flex-col gap-3">
              {invite.state !== "pending" ? (
                <Alert tone="info">{STATE_MESSAGES[invite.state]}</Alert>
              ) : status === "unauthenticated" ? (
                <>
                  <p className="text-sm">Sign in, or create an account, with the email address the invite was sent to.</p>
                  <Link
                    href={`/signup?next=${encodeURIComponent(here)}`}
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background"
                  >
                    Create an account
                  </Link>
                  <Link
                    href={`/login?next=${encodeURIComponent(here)}`}
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-300 px-4 text-sm font-medium dark:border-neutral-700"
                  >
                    I already have an account
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-sm text-neutral-500">Signed in as {user!.email}</p>
                  {error ? <Alert tone="error">{error.text}</Alert> : null}
                  {error?.code === "EMAIL_NOT_VERIFIED" ? (
                    <Button
                      variant="secondary"
                      disabled={resent}
                      onClick={() =>
                        resendVerification().then(
                          () => setResent(true),
                          () => setResent(false),
                        )
                      }
                    >
                      {resent ? "Verification email sent. Open it, then come back here" : "Send the verification email again"}
                    </Button>
                  ) : null}
                  {error?.code === "INVITE_EMAIL_MISMATCH" ? (
                    <Button variant="secondary" onClick={() => void logout()}>
                      Log out and use another account
                    </Button>
                  ) : (
                    <Button loading={busy} onClick={accept}>
                      Join {invite.workspaceName}
                    </Button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
