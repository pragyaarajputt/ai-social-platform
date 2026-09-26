"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ApiError } from "@/lib/api";
import { listWorkspaces, type Workspace } from "@/lib/workspaces";

type WorkspaceState = (
  | { status: "loading"; workspace: null; error: null }
  | { status: "ready"; workspace: Workspace; error: null }
  | { status: "error"; workspace: null; error: string }
) & {
  /** Every workspace the user belongs to. */
  workspaces: Workspace[];
  /** Switches to another workspace (remembered in this browser). */
  selectWorkspace: (id: string) => void;
  /** Loads the list again (after creating, joining, leaving or renaming), optionally switching to `selectId`. */
  reload: (selectId?: string) => void;
};

const noop = () => undefined;
const LOADING: WorkspaceState = { status: "loading", workspace: null, error: null, workspaces: [], selectWorkspace: noop, reload: noop };
const WorkspaceContext = createContext<WorkspaceState>(LOADING);

// The chosen workspace, per user and browser. A convenience only: anything missing falls back to the first.
const storageKey = (userId: string) => `ai-social:workspace:${userId}`;
export function rememberWorkspace(userId: string, workspaceId: string) {
  try {
    localStorage.setItem(storageKey(userId), workspaceId);
  } catch {
    // Private mode or storage blocked: the first workspace is used instead.
  }
}
function rememberedWorkspace(userId: string): string | null {
  try {
    return localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
}

/** Loads the signed-in user's workspaces and which one they're working in. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, user } = useAuth();
  const userId = user?.id ?? null;
  const [loaded, setLoaded] = useState<{ userId: string; workspaces: Workspace[]; selectedId: string | null; error: string | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (authStatus !== "authenticated" || !userId) return;
    let active = true;
    listWorkspaces().then(
      (workspaces) =>
        active &&
        setLoaded((prev) => ({
          userId,
          workspaces,
          // Keep the current choice across reloads; on first load, use the remembered one.
          selectedId: prev?.userId === userId && prev.selectedId ? prev.selectedId : rememberedWorkspace(userId),
          error: null,
        })),
      (err: unknown) =>
        active && setLoaded({ userId, workspaces: [], selectedId: null, error: err instanceof ApiError ? err.message : "Couldn't load your workspace." }),
    );
    return () => {
      active = false;
    };
  }, [authStatus, userId, reloadKey]);

  const selectWorkspace = useCallback(
    (id: string) => {
      if (!userId) return;
      rememberWorkspace(userId, id);
      setLoaded((prev) => (prev ? { ...prev, selectedId: id } : prev));
    },
    [userId],
  );
  const reload = useCallback(
    (selectId?: string) => {
      if (selectId) selectWorkspace(selectId);
      setReloadKey((k) => k + 1);
    },
    [selectWorkspace],
  );

  // Results from a previous user (after sign-out and sign-in as someone else) are ignored.
  const current = loaded && loaded.userId === userId ? loaded : null;
  let state: WorkspaceState;
  if (!current) state = { ...LOADING, selectWorkspace, reload };
  else if (current.error) state = { status: "error", workspace: null, error: current.error, workspaces: [], selectWorkspace, reload };
  else {
    const workspace = current.workspaces.find((w) => w.id === current.selectedId) ?? current.workspaces[0];
    state = workspace
      ? { status: "ready", workspace, error: null, workspaces: current.workspaces, selectWorkspace, reload }
      : { status: "error", workspace: null, error: "Your account has no workspace.", workspaces: [], selectWorkspace, reload };
  }
  return <WorkspaceContext value={state}>{children}</WorkspaceContext>;
}

export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}
