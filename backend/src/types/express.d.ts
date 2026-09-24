import type { Role } from "../generated/prisma/enums.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: { id: string; role: Role };
    }
  }
}

export {};
