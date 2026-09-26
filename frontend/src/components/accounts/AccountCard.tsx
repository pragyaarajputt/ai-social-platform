"use client";

import { useState } from "react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/Button";
import { formatDateTime, formatRelative, useNow } from "@/lib/dates";
import { platformName } from "@/lib/platforms";
import type { SocialAccount } from "@/lib/workspaces";

const statusLabel: Record<SocialAccount["status"], { text: string; className: string }> = {
  ACTIVE: { text: "Connected", className: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  NEEDS_REAUTH: { text: "Reconnect needed", className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" },
  REVOKED: { text: "Access removed", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  DISCONNECTED: { text: "Disconnected", className: "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400" },
};

const accountTypeLabel: Record<string, string> = { BUSINESS: "Business", MEDIA_CREATOR: "Creator", PAGE: "Page" };

export function AccountCard({
  account,
  canManage,
  reconnecting,
  onReconnect,
  onDisconnect,
  loadDisconnectImpact,
}: {
  account: SocialAccount;
  canManage: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: (scheduledPosts: "cancel" | "keep") => Promise<void>;
  /** Scheduled posts that use this account, shown in the disconnect confirmation. */
  loadDisconnectImpact: () => Promise<{ scheduledPosts: number; nextScheduledAt: string | null }>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<{ scheduledPosts: number; nextScheduledAt: string | null } | "loading" | "unknown">("loading");
  const [keepScheduled, setKeepScheduled] = useState(false);
  const now = useNow(60_000);

  function startConfirming() {
    setConfirming(true);
    setKeepScheduled(false);
    setImpact("loading");
    loadDisconnectImpact().then(setImpact, () => setImpact("unknown"));
  }
  const status = statusLabel[account.status];
  // Facebook Pages are known by their name; Instagram accounts by their @username.
  const handle = account.platform === "FACEBOOK" ? (account.name ?? account.username ?? account.externalId) : account.username ? `@${account.username}` : (account.name ?? account.externalId);
  const needsAttention = account.status === "NEEDS_REAUTH" || account.status === "REVOKED";
  // Connected before analytics existed, or the insights permission wasn't granted.
  const analyticsOff = account.status === "ACTIVE" && !account.insightsAllowed;

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
          <p className="flex items-center gap-1.5 text-sm text-neutral-500">
            <PlatformIcon platform={account.platform} className="h-3.5 w-3.5" />
            {platformName(account.platform)}
            {account.accountType ? ` · ${accountTypeLabel[account.accountType] ?? account.accountType}` : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.text}</span>
      </div>

      <p className="mt-3 text-sm text-neutral-500">
        {account.status === "ACTIVE"
          ? account.tokenExpiresAt
            ? `Access renews automatically${expiryNote(account.tokenExpiresAt)}.`
            : `Access doesn't expire. It stops only if the app is removed on ${platformName(account.platform)} or you lose your role.`
          : account.status === "NEEDS_REAUTH"
            ? "Access to this account expired. Reconnect to keep publishing."
            : account.status === "REVOKED"
              ? `Access was removed on ${platformName(account.platform)}. Reconnect to publish again.`
              : null}
      </p>
      {account.status === "ACTIVE" && account.lastCheckedAt ? (
        <p className="mt-1 text-xs text-neutral-500">Connection checked {formatRelative(new Date(account.lastCheckedAt), new Date(now))}.</p>
      ) : null}
      {analyticsOff ? (
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">Analytics are off: reconnect and allow access to insights.</p>
      ) : null}

      {canManage ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {needsAttention || analyticsOff ? (
            <div className="w-auto">
              <Button variant={needsAttention ? "primary" : "secondary"} loading={reconnecting} onClick={onReconnect}>
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
              {impact === "loading" ? (
                <p className="text-neutral-500">Checking scheduled posts…</p>
              ) : impact === "unknown" ? (
                <p className="text-neutral-500">Couldn&apos;t check scheduled posts. Scheduled posts using this account will be cancelled for it.</p>
              ) : impact.scheduledPosts > 0 ? (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  <p>
                    {keepScheduled ? "Keeping" : "This cancels"}{" "}
                    <strong>
                      {impact.scheduledPosts} scheduled post{impact.scheduledPosts === 1 ? "" : "s"}
                    </strong>{" "}
                    for {handle}
                    {impact.nextScheduledAt ? ` (next: ${formatDateTime(new Date(impact.nextScheduledAt))})` : ""}. Other accounts in those posts still
                    publish.
                  </p>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-0.5" checked={keepScheduled} onChange={(e) => setKeepScheduled(e.target.checked)} />
                    Keep them instead. They&apos;ll publish if you reconnect before their time; otherwise they fail.
                  </label>
                </div>
              ) : null}
              <div className="flex gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={impact === "loading"}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onDisconnect(keepScheduled ? "keep" : "cancel");
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
              <Button variant="secondary" onClick={startConfirming}>
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
