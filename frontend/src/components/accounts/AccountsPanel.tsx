"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/Button";
import { PageLoading } from "@/components/auth/RequireAuth";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import {
  canManageAccounts,
  disconnectAccount,
  getDisconnectImpact,
  listSocialAccounts,
  startConnect,
  type PlatformInfo,
  type SocialAccount,
  type SocialPlatform,
} from "@/lib/workspaces";
import { AccountCard } from "./AccountCard";
import { connectResultMessage, platformDisplayName } from "./connectMessages";

type Data = { accounts: SocialAccount[]; platforms: PlatformInfo[] };

export function AccountsPanel() {
  const { status, workspace, error: workspaceError } = useWorkspace();
  const params = useSearchParams();
  const router = useRouter();

  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<SocialPlatform | null>(null);
  // The result of the OAuth round trip, read once from the URL, which is then cleaned up.
  const [result] = useState(() => connectResultMessage(new URLSearchParams(params.toString()), platformDisplayName));

  useEffect(() => {
    if (params.has("connected") || params.has("error")) router.replace("/accounts");
  }, [params, router]);

  const workspaceId = workspace?.id;
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    listSocialAccounts(workspaceId).then(
      (loaded) => {
        if (!active) return;
        setData(loaded);
        setLoadError(null);
      },
      (err: unknown) => active && setLoadError(err instanceof ApiError ? err.message : "Couldn't load your accounts."),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, reloadKey]);

  if (status === "error") return <Page><Alert tone="error">{workspaceError}</Alert></Page>;
  if (status === "loading" || (!data && !loadError)) return <PageLoading />;

  const canManage = canManageAccounts(workspace!.role);

  async function connect(platform: SocialPlatform) {
    setActionError(null);
    setConnecting(platform);
    try {
      // Leaves the app for the platform's consent screen; the backend redirects back here.
      window.location.assign(await startConnect(workspaceId!, platform));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't start the connection. Try again.");
      setConnecting(null);
    }
  }

  async function disconnect(account: SocialAccount, scheduledPosts: "cancel" | "keep") {
    setActionError(null);
    try {
      await disconnectAccount(workspaceId!, account.id, scheduledPosts);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't disconnect the account. Try again.");
    }
  }

  return (
    <Page>
      <div className="flex flex-col gap-3">
        {result ? <Alert tone={result.tone}>{result.text}</Alert> : null}
        {loadError ? <Alert tone="error">{loadError}</Alert> : null}
        {actionError ? <Alert tone="error">{actionError}</Alert> : null}
        {!canManage ? (
          <Alert tone="info">Only workspace owners and admins can connect or disconnect accounts.</Alert>
        ) : null}
      </div>

      <section aria-labelledby="connected-heading" className="mt-8">
        <h2 id="connected-heading" className="text-sm font-medium text-neutral-500">
          Connected
        </h2>
        {data && data.accounts.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {data.accounts.map((account) => (
              <li key={account.id}>
                <AccountCard
                  account={account}
                  canManage={canManage}
                  reconnecting={connecting === account.platform}
                  onReconnect={() => connect(account.platform)}
                  onDisconnect={(scheduledPosts) => disconnect(account, scheduledPosts)}
                  loadDisconnectImpact={() => getDisconnectImpact(workspaceId!, account.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No accounts connected yet. Connect one below to start publishing.
          </p>
        )}
      </section>

      {canManage && data ? (
        <section aria-labelledby="add-heading" className="mt-10">
          <h2 id="add-heading" className="text-sm font-medium text-neutral-500">
            Add an account
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {data.platforms.map((p) => (
              <li
                key={p.platform}
                className="flex flex-col gap-3 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800"
              >
                <div className="flex items-start gap-3">
                  <PlatformIcon platform={p.platform} className="mt-0.5 h-6 w-6" />
                  <div>
                    <p className="font-medium">{p.displayName}</p>
                    <p className="text-sm text-neutral-500">
                      {p.platform === "INSTAGRAM"
                        ? "Business or Creator accounts"
                        : p.platform === "FACEBOOK"
                          ? "Pages you manage. Choose one or more in Facebook's window."
                          : p.platform === "LINKEDIN"
                            ? "Your personal profile. Company Pages aren't supported yet."
                            : "Coming soon"}
                    </p>
                  </div>
                </div>
                {p.configured ? (
                  <Button loading={connecting === p.platform} disabled={connecting !== null} onClick={() => connect(p.platform)}>
                    {p.platform === "FACEBOOK" ? "Connect Facebook Pages" : `Connect ${p.displayName}`}
                  </Button>
                ) : (
                  <p className="text-sm text-neutral-500">Not set up on this server yet.</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Connected accounts</h1>
      <p className="mt-1 text-sm text-neutral-500">The social accounts this workspace can publish to.</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}
