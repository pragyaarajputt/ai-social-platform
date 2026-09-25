"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ApiError } from "@/lib/api";
import { listWorkspaces, type Workspace } from "@/lib/workspaces";

type WorkspaceState =
  | { status: "loading"; workspace: null; error: null }
  | { status: "ready"; workspace: Workspace; error: null }
  | { status: "error"; workspace: null; error: string };

const LOADING: WorkspaceState = { status: "loading", workspace: null, error: null };
const WorkspaceContext = createContext<WorkspaceState>(LOADING);

/**
 * Loads the signed-in user's workspace. Every user has a personal workspace; with teams there
 * will be several, and this is where a workspace switcher will plug in.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, user } = useAuth();
  const userId = user?.id ?? null;
  const [loaded, setLoaded] = useState<{ userId: string; state: WorkspaceState } | null>(null);

  useEffect(() => {
    if (authStatus !== "authenticated" || !userId) return;
    let active = true;
    listWorkspaces().then(
      (workspaces) => {
        if (!active) return;
        const first = workspaces[0];
        setLoaded({
          userId,
          state: first
            ? { status: "ready", workspace: first, error: null }
            : { status: "error", workspace: null, error: "Your account has no workspace. Contact support." },
        });
      },
      (err: unknown) => {
        if (!active) return;
        setLoaded({
          userId,
          state: { status: "error", workspace: null, error: err instanceof ApiError ? err.message : "Couldn't load your workspace." },
        });
      },
    );
    return () => {
      active = false;
    };
  }, [authStatus, userId]);

  // Results from a previous user (after sign-out and sign-in as someone else) are ignored.
  const state = loaded && loaded.userId === userId ? loaded.state : LOADING;
  return <WorkspaceContext value={state}>{children}</WorkspaceContext>;
}

export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}
