import type { ReactNode } from "react";
import { RequireAuth } from "@/components/auth/RequireAuth";

/** Every page in this group requires a signed-in user. The API enforces access; this handles navigation. */
export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
