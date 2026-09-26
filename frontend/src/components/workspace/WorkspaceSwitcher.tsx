"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { createWorkspace } from "@/lib/team";
import { useWorkspace } from "./WorkspaceProvider";

const NEW = "__new__";

/** Header control: which workspace you're working in, and creating a new one. */
export function WorkspaceSwitcher() {
  const { workspace, workspaces, selectWorkspace, reload } = useWorkspace();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!workspace) return null;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createWorkspace(name.trim());
      reload(created.id);
      setCreating(false);
      setName("");
      router.push("/settings/workspace");
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.message) : "Couldn't create the workspace.");
    } finally {
      setBusy(false);
    }
  }

  if (creating) {
    return (
      <form onSubmit={create} className="flex items-center gap-1 text-sm">
        <label htmlFor="new-workspace" className="sr-only">
          New workspace name
        </label>
        <input
          id="new-workspace"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Workspace name"
          className="h-8 w-40 rounded-lg border border-neutral-300 bg-transparent px-2 dark:border-neutral-700"
        />
        <button type="submit" disabled={busy || !name.trim()} className="h-8 rounded-lg bg-foreground px-2 text-background disabled:opacity-50">
          Create
        </button>
        <button type="button" onClick={() => setCreating(false)} className="h-8 px-1 text-neutral-500 hover:underline">
          Cancel
        </button>
        {error ? (
          <span role="alert" className="text-xs text-red-600">
            {error}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="sr-only">Workspace</span>
      <select
        value={workspace.id}
        onChange={(e) => {
          if (e.target.value === NEW) {
            setCreating(true);
            return;
          }
          selectWorkspace(e.target.value);
          // Pages showing one post or account belong to the previous workspace.
          if (/^\/posts\/[^/]+/.test(window.location.pathname)) router.push("/posts");
        }}
        className="h-8 max-w-44 truncate rounded-lg border border-neutral-300 bg-transparent px-2 dark:border-neutral-700"
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        <option value={NEW}>+ New workspace…</option>
      </select>
    </label>
  );
}
