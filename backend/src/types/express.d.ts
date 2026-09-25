import type { Role, WorkspaceRole } from "../generated/prisma/enums.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: { id: string; role: Role };
      /** Set by requireWorkspace. */
      workspace?: { id: string; role: WorkspaceRole };
    }
  }
}

export {};
