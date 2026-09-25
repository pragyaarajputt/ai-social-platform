import { prisma } from "../config/database.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface AuditEntry {
  action: string;
  workspaceId?: string | null;
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonObject;
}

/** Records who did what. Pass a transaction client to write it atomically with the change itself. */
export function audit(entry: AuditEntry, db: Pick<typeof prisma, "auditLog"> = prisma) {
  return db.auditLog.create({ data: { ...entry, metadata: entry.metadata ?? {} } });
}
