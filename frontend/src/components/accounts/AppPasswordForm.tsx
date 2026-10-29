"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { ApiError } from "@/lib/api";
import { connectWithAppPassword, type SocialAccount, type SocialPlatform } from "@/lib/workspaces";

/**
 * Connecting a platform that uses app passwords (Bluesky) instead of a redirect. The password goes
 * straight to our API, which swaps it for session tokens and doesn't keep it.
 */
export function AppPasswordForm({
  workspaceId,
  platform,
  displayName,
  onConnected,
  onCancel,
}: {
  workspaceId: string;
  platform: SocialPlatform;
  displayName: string;
  onConnected(account: SocialAccount): void;
  onCancel(): void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { accounts } = await connectWithAppPassword(workspaceId, platform, identifier, appPassword);
      setAppPassword("");
      onConnected(accounts[0]!);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't connect ${displayName}. Try again.`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Browsers and password managers must not fill this in: they'd offer the PostDrip login, and its
    // password would be sent to Bluesky. "new-password" is the value browsers respect for that.
    <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <FormField
        label="Handle"
        name="bluesky-handle"
        placeholder="yourname.bsky.social"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        required
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
      />
      <FormField
        label="App password"
        name="bluesky-app-password"
        type="password"
        placeholder="xxxx-xxxx-xxxx-xxxx"
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        required
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
        hint="Not your main password. Create one in Bluesky under Settings → Privacy and security → App passwords. PostDrip doesn't store it."
      />
      <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
        Open Bluesky&apos;s app password settings ↗
      </a>
      <div className="flex gap-2">
        <Button type="submit" loading={submitting} disabled={!identifier.trim() || !appPassword.trim()}>
          Connect {displayName}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
