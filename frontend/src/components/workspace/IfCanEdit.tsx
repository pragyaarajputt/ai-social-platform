"use client";

import type { ReactNode } from "react";
import { canEditPosts } from "@/lib/team";
import { useWorkspace } from "./WorkspaceProvider";

/** Shows its children only to people who can create and edit posts (editors and up). The API enforces it too. */
export function IfCanEdit({ children, otherwise = null }: { children: ReactNode; otherwise?: ReactNode }) {
  const { workspace } = useWorkspace();
  return workspace && canEditPosts(workspace.role) ? children : otherwise;
}
