import { z } from "zod";
import { email } from "./auth.schemas.js";

const name = z.string().trim().min(1, "Enter a name").max(80, "At most 80 characters");
/** Roles that can be given; OWNER only changes hands through a transfer. */
const assignableRole = z.enum(["ADMIN", "EDITOR", "VIEWER"]);

export const createWorkspaceSchema = z.object({ name });
export const renameWorkspaceSchema = z.object({ name });

/**
 * Deleting a workspace or giving it away: type the workspace name, and the password for accounts
 * that have one (Google-only accounts have none).
 */
const confirmation = { confirmName: z.string(), password: z.string().max(128).optional() };
export const deleteWorkspaceSchema = z.object(confirmation);
export const transferOwnershipSchema = z.object({ userId: z.uuid("Invalid ID"), ...confirmation });

export const changeRoleSchema = z.object({ role: assignableRole });
export const removeMemberSchema = z.object({
  /** Disconnect the accounts this member connected with their own login (their tokens). */
  disconnectAccounts: z.boolean().default(true),
});

export const createInviteSchema = z.object({ email, role: assignableRole });

export type AssignableRole = z.infer<typeof assignableRole>;
