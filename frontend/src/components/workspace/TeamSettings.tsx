"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  assignableRoles,
  atLeast,
  canManageMember,
  changeRole,
  createInvite,
  deleteWorkspace,
  leaveWorkspace,
  listInvites,
  listMembers,
  removeMember,
  renameWorkspace,
  resendInvite,
  revokeInvite,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  transferOwnership,
  type AssignableRole,
  type Invite,
  type Member,
} from "@/lib/team";
import { useWorkspace } from "./WorkspaceProvider";

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.message) : fallback);
const inputClass = "h-10 rounded-lg border border-neutral-300 bg-transparent px-3 text-sm dark:border-neutral-700";

/** /settings/workspace: the workspace's name, members, invites, and owner-only actions. */
export function TeamSettings() {
  const { workspace, workspaces, reload } = useWorkspace();
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<{ workspaceId: string; members: Member[]; invites: Invite[] } | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string; link?: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const workspaceId = workspace?.id;
  const isAdmin = workspace ? atLeast(workspace.role, "ADMIN") : false;
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    Promise.all([listMembers(workspaceId), isAdmin ? listInvites(workspaceId) : Promise.resolve([])]).then(
      ([members, invites]) => active && setData({ workspaceId, members, invites }),
      (err: unknown) => active && setNotice({ tone: "error", text: message(err, "Couldn't load the team.") }),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, isAdmin, refreshKey]);

  if (!workspace || !user || data?.workspaceId !== workspace.id) return <PageLoading />;
  const me = { userId: user.id, role: workspace.role };
  const others = data.members.filter((m) => m.userId !== user.id);

  /** Runs an action, shows its result, and reloads the team (and the workspace list when it changed). */
  async function act(run: () => Promise<unknown>, success: string, opts: { reloadWorkspaces?: boolean; goHome?: boolean } = {}) {
    setNotice(null);
    try {
      await run();
      setNotice({ tone: "success", text: success });
      if (opts.reloadWorkspaces) reload();
      if (opts.goHome) router.push("/");
      else refresh();
      return true;
    } catch (err) {
      setNotice({ tone: "error", text: message(err, "That didn't work. Try again.") });
      return false;
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Team</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {workspace.name} · you&apos;re {ROLE_LABELS[workspace.role].toLowerCase()}
      </p>
      {notice ? (
        <div className="mt-4">
          <Alert tone={notice.tone}>
            {notice.text}
            {notice.link ? <CopyLink link={notice.link} /> : null}
          </Alert>
        </div>
      ) : null}

      {isAdmin ? (
        <WorkspaceName
          name={workspace.name}
          onSave={(name) => act(() => renameWorkspace(workspace.id, name), "Workspace renamed.", { reloadWorkspaces: true })}
        />
      ) : null}

      {/* Members */}
      <section className="mt-8" aria-labelledby="members">
        <h2 id="members" className="text-sm font-medium">
          Members ({data.members.length})
        </h2>
        <ul className="mt-3 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {data.members.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              isMe={m.userId === user.id}
              canManage={canManageMember(me, m)}
              roles={workspace.role === "OWNER" ? ["ADMIN", "EDITOR", "VIEWER"] : assignableRoles(workspace.role)}
              onRole={(role) => act(() => changeRole(workspace.id, m.userId, role), `${m.displayName} is now ${ROLE_LABELS[role].toLowerCase()}.`)}
              onRemove={(disconnect) =>
                act(
                  () => removeMember(workspace.id, m.userId, disconnect),
                  `${m.displayName} was removed${disconnect && m.connectedAccounts ? ` and the accounts they connected were disconnected` : ""}.`,
                )
              }
            />
          ))}
        </ul>
      </section>

      {/* Invites */}
      {isAdmin ? (
        <section className="mt-8" aria-labelledby="invite">
          <h2 id="invite" className="text-sm font-medium">
            Invite someone
          </h2>
          <InviteForm
            roles={assignableRoles(workspace.role)}
            onInvite={async (email, role) => {
              setNotice(null);
              try {
                const res = await createInvite(workspace.id, email, role);
                setNotice({ tone: "success", text: `Invite sent to ${email}. It works once and expires in 7 days. You can also send the link yourself:`, link: res.link });
                refresh();
                return true;
              } catch (err) {
                setNotice({ tone: "error", text: message(err, "Couldn't send the invite.") });
                return false;
              }
            }}
          />
          {data.invites.length ? (
            <ul className="mt-4 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
              {data.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                  <span className="min-w-0 flex-1 truncate">
                    <strong className="font-medium">{i.email}</strong> · {ROLE_LABELS[i.role]}
                    <span className={`block text-xs ${i.state === "expired" ? "text-amber-700 dark:text-amber-400" : "text-neutral-500"}`}>
                      {i.state === "expired" ? "Expired" : `Sent ${formatDateTime(new Date(i.lastSentAt))} · expires ${formatDateTime(new Date(i.expiresAt))}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={async () => {
                      setNotice(null);
                      try {
                        const res = await resendInvite(workspace.id, i.id);
                        setNotice({ tone: "success", text: `Sent a new invite to ${i.email}. The old link no longer works. New link:`, link: res.link });
                        refresh();
                      } catch (err) {
                        setNotice({ tone: "error", text: message(err, "Couldn't resend the invite.") });
                      }
                    }}
                  >
                    Resend
                  </button>
                  <button type="button" className="text-red-600 underline" onClick={() => act(() => revokeInvite(workspace.id, i.id), `Invite for ${i.email} withdrawn.`)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* Leaving, ownership, deletion */}
      <section className="mt-10 flex flex-col gap-4 border-t border-neutral-200 pt-6 dark:border-neutral-800" aria-labelledby="danger">
        <h2 id="danger" className="text-sm font-medium">
          {workspace.role === "OWNER" ? "Ownership" : "Your membership"}
        </h2>
        {workspace.role !== "OWNER" ? (
          <Confirm
            label="Leave workspace"
            question={`Leave ${workspace.name}? You'll lose access until someone invites you again.`}
            onConfirm={() => act(() => leaveWorkspace(workspace.id), `You left ${workspace.name}.`, { reloadWorkspaces: true, goHome: true })}
          />
        ) : (
          <>
            {others.length ? (
              <OwnerAction
                label="Transfer ownership"
                description="The new owner can delete the workspace and manage admins. You become an admin."
                workspaceName={workspace.name}
                members={others}
                onConfirm={(userId, confirmName, password) =>
                  act(() => transferOwnership(workspace.id, { userId, confirmName, password: password || undefined }), "Ownership transferred. You're now an admin.", {
                    reloadWorkspaces: true,
                  })
                }
              />
            ) : (
              <p className="text-sm text-neutral-500">To leave this workspace, invite someone and transfer ownership to them, or delete it.</p>
            )}
            {workspaces.length > 1 ? (
              <OwnerAction
                label="Delete workspace"
                danger
                description="Deletes its posts (including scheduled ones), media records, connected accounts and team. This can't be undone."
                workspaceName={workspace.name}
                onConfirm={(_userId, confirmName, password) =>
                  act(() => deleteWorkspace(workspace.id, { confirmName, password: password || undefined }), `${workspace.name} was deleted.`, {
                    reloadWorkspaces: true,
                    goHome: true,
                  })
                }
              />
            ) : (
              <p className="text-sm text-neutral-500">This is your only workspace, so it can&apos;t be deleted.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function WorkspaceName({ name, onSave }: { name: string; onSave: (name: string) => Promise<boolean> }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-6 flex items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave(value.trim());
        setBusy(false);
      }}
    >
      <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
        Workspace name
        <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} className={inputClass} />
      </label>
      <div className="w-28">
        <Button type="submit" variant="secondary" loading={busy} disabled={!value.trim() || value.trim() === name}>
          Rename
        </Button>
      </div>
    </form>
  );
}

function MemberRow({
  member: m,
  isMe,
  canManage,
  roles,
  onRole,
  onRemove,
}: {
  member: Member;
  isMe: boolean;
  canManage: boolean;
  roles: AssignableRole[];
  onRole: (role: AssignableRole) => Promise<boolean>;
  onRemove: (disconnectAccounts: boolean) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [disconnect, setDisconnect] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <li className="p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {m.displayName} {isMe ? <span className="font-normal text-neutral-500">(you)</span> : null}
          </p>
          <p className="truncate text-xs text-neutral-500">
            @{m.username}
            {m.email ? ` · ${m.email}` : ""}
          </p>
        </div>
        {canManage ? (
          <label className="text-xs">
            <span className="sr-only">Role for {m.displayName}</span>
            <select
              value={m.role}
              onChange={(e) => void onRole(e.target.value as AssignableRole)}
              title={ROLE_DESCRIPTIONS[m.role]}
              className="h-8 rounded-lg border border-neutral-300 bg-transparent px-2 dark:border-neutral-700"
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs dark:bg-neutral-900" title={ROLE_DESCRIPTIONS[m.role]}>
            {ROLE_LABELS[m.role]}
          </span>
        )}
        {canManage ? (
          <button type="button" className="text-xs text-red-600 underline" onClick={() => setConfirming(true)}>
            Remove
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div className="mt-3 flex flex-col gap-2 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-900">
          <p>
            Remove <strong>{m.displayName}</strong>? They lose access right away. Their posts stay in the workspace.
          </p>
          {m.connectedAccounts ? (
            <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <input type="checkbox" className="mt-0.5" checked={disconnect} onChange={(e) => setDisconnect(e.target.checked)} />
              <span>
                Also disconnect the {m.connectedAccounts} account{m.connectedAccounts === 1 ? "" : "s"} they connected (recommended: the access belongs to their
                login). Their scheduled posts on those accounts are cancelled.
              </span>
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onRemove(disconnect && m.connectedAccounts > 0);
                setBusy(false);
                if (ok) setConfirming(false);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function InviteForm({ roles, onInvite }: { roles: AssignableRole[]; onInvite: (email: string, role: AssignableRole) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("EDITOR");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await onInvite(email.trim(), role)) setEmail("");
        setBusy(false);
      }}
    >
      <label className="flex flex-1 flex-col gap-1.5 text-sm">
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} className={inputClass}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <div className="sm:w-36">
        <Button type="submit" loading={busy} disabled={!email.trim()}>
          Send invite
        </Button>
      </div>
      <p className="text-xs text-neutral-500 sm:hidden">{ROLE_DESCRIPTIONS[role]}</p>
    </form>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mt-2 flex flex-wrap items-center gap-2">
      <code className="max-w-full truncate rounded bg-white/60 px-2 py-1 text-xs dark:bg-black/30">{link}</code>
      <button
        type="button"
        className="text-xs font-medium underline"
        onClick={() =>
          navigator.clipboard.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </span>
  );
}

function Confirm({ label, question, onConfirm }: { label: string; question: string; onConfirm: () => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div className="w-44">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
      <p>{question}</p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
            setBusy(false);
          }}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

/** Transfer or delete: pick a member (for transfers), type the workspace name, and enter the password. */
function OwnerAction({
  label,
  description,
  workspaceName,
  members,
  danger,
  onConfirm,
}: {
  label: string;
  description: string;
  workspaceName: string;
  members?: Member[];
  danger?: boolean;
  onConfirm: (userId: string, confirmName: string, password: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState(members?.[0]?.userId ?? "");
  const [confirmName, setConfirmName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {!open ? (
        <div className="flex flex-col gap-1">
          <div className="w-52">
            <Button variant={danger ? "danger" : "secondary"} onClick={() => setOpen(true)}>
              {label}
            </Button>
          </div>
          <p className="text-xs text-neutral-500">{description}</p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await onConfirm(userId, confirmName, password);
            setBusy(false);
            if (ok) setOpen(false);
          }}
        >
          <p className="font-medium">{label}</p>
          <p className="text-neutral-600 dark:text-neutral-400">{description}</p>
          {members ? (
            <label className="flex flex-col gap-1.5">
              New owner
              <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputClass}>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName} (@{m.username}, {ROLE_LABELS[m.role].toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1.5">
            Type <strong>{workspaceName}</strong> to confirm
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className={inputClass} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5">
            Your password <span className="text-xs text-neutral-500">(leave empty if you only sign in with Google)</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={inputClass} />
          </label>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={danger ? "danger" : "primary"} loading={busy} disabled={confirmName !== workspaceName}>
              {label}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
