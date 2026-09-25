"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { initSession } from "@/lib/auth";
import { sessionStore, type SessionState } from "@/lib/auth-session";

const AuthContext = createContext<SessionState>(sessionStore.getServerSnapshot());

/** Provides the session (see lib/auth-session.ts) to the app and restores it from the refresh cookie on load. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(sessionStore.getServerSnapshot);

  useEffect(() => {
    const sync = () => setState(sessionStore.getSnapshot());
    const unsubscribe = sessionStore.subscribe(sync);
    queueMicrotask(sync); // pick up anything that changed before we subscribed
    void initSession(); // restore the session from the refresh cookie
    return unsubscribe;
  }, []);

  return <AuthContext value={state}>{children}</AuthContext>;
}

export function useAuth(): SessionState {
  return useContext(AuthContext);
}
