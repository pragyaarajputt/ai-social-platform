"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { SocialAccount } from "@/lib/workspaces";

const statusLabel: Record<SocialAccount["status"], { text: string; className: string }> = {
  ACTIVE: { text: "Connected", className: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  NEEDS_REAUTH: { text: "Reconnect needed", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
  REVOKED: { text: "Access removed", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  DISCONNECTED: { text: "Disconnected", className: "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400" },
};

const accountTypeLabel: Record<string, string> = { BUSINESS: "Business", MEDIA_CREATOR: "Creator" };

export function AccountCard({
  account,
  canManage,
  reconnecting,
  onReconnect,
  onDisconnect,
}: {
  account: SocialAccount;
  canManage: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = statusLabel[account.status];
  const handle = account.username ? `@${account.username}` : account.name ?? account.externalId;
  const needsAttention = account.status === "NEEDS_REAUTH" || account.status === "REVOKED";

  return (
    <div className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center gap-3">
        {account.avatarUrl ? (
          // Platform CDN URLs expire and change hosts, so next/image's allowlist doesn't fit here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div aria-hidden className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200 text-sm font-medium dark:bg-neutral-800">
            {handle.replace("@", "").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{handle}</p>
          <p className="text-sm text-neutral-500">
            Instagram{account.accountType ? ` · ${accountTypeLabel[account.accountType] ?? account.accountType}` : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.text}</span>
      </div>

      <p className="mt-3 text-sm text-neutral-500">
        {account.status === "ACTIVE"
          ? `Access renews automatically${expiryNote(account.tokenExpiresAt)}.`
          : account.status === "NEEDS_REAUTH"
            ? "Access to this account expired. Reconnect to keep publishing."
            : account.status === "REVOKED"
              ? "Access was removed from the Instagram side. Reconnect to publish again."
              : null}
      </p>

      {canManage ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {needsAttention ? (
            <div className="w-auto">
              <Button loading={reconnecting} onClick={onReconnect}>
                Reconnect
              </Button>
            </div>
          ) : null}
          {confirming ? (
            <div className="flex w-full flex-col gap-2 rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
              <p>
                Disconnect <strong>{handle}</strong>? This workspace won&apos;t be able to publish to it until it&apos;s connected
                again.
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onDisconnect();
                    } finally {
                      setBusy(false);
                      setConfirming(false);
                    }
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="w-auto">
              <Button variant="secondary" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function expiryNote(expiresAt: string | null): string {
  if (!expiresAt) return "";
  const days = Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  return days > 0 ? ` (current access valid for ${days} more day${days === 1 ? "" : "s"})` : "";
}
