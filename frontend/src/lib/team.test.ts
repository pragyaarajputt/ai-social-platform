import { describe, expect, it } from "vitest";
import { assignableRoles, canEditPosts, canManageMember } from "./team";

describe("team permissions (mirroring the server)", () => {
  const me = (role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER") => ({ userId: "me", role });
  const them = (role: "OWNER" | "ADMIN" | "EDITOR" | "VIEWER") => ({ userId: "them", role });

  it("owners manage everyone but themselves", () => {
    expect(canManageMember(me("OWNER"), them("ADMIN"))).toBe(true);
    expect(canManageMember(me("OWNER"), them("VIEWER"))).toBe(true);
    expect(canManageMember(me("OWNER"), { userId: "me", role: "OWNER" })).toBe(false);
  });

  it("admins manage editors and viewers, not admins or the owner", () => {
    expect(canManageMember(me("ADMIN"), them("EDITOR"))).toBe(true);
    expect(canManageMember(me("ADMIN"), them("VIEWER"))).toBe(true);
    expect(canManageMember(me("ADMIN"), them("ADMIN"))).toBe(false);
    expect(canManageMember(me("ADMIN"), them("OWNER"))).toBe(false);
  });

  it("editors and viewers manage nobody, and only editors and up edit posts", () => {
    expect(canManageMember(me("EDITOR"), them("VIEWER"))).toBe(false);
    expect(assignableRoles("EDITOR")).toEqual([]);
    expect(assignableRoles("ADMIN")).toEqual(["ADMIN", "EDITOR", "VIEWER"]);
    expect(canEditPosts("VIEWER")).toBe(false);
    expect(canEditPosts("EDITOR")).toBe(true);
  });
});
