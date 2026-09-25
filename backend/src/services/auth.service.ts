import { randomBytes } from "node:crypto";
import { prisma } from "../config/database.js";
import { Prisma } from "../generated/prisma/client.js";
import type { Role } from "../generated/prisma/enums.js";
import type { LoginInput, RegisterInput } from "../schemas/auth.schemas.js";
import { AppError } from "../utils/AppError.js";
import { dummyVerify, hashPassword, verifyPassword } from "../utils/password.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "./email.service.js";
import type { GoogleProfile } from "./google-oauth.service.js";
import { consumeVerificationToken, createVerificationToken, revokeAllForUser } from "./token.service.js";
import { personalWorkspaceMembership } from "./workspace.service.js";

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  emailVerified: boolean;
  displayName: string | null;
  createdAt: Date;
}

const publicUserSelect = {
  id: true,
  email: true,
  username: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  profile: { select: { displayName: true } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    emailVerified: u.emailVerifiedAt !== null,
    displayName: u.profile?.displayName ?? null,
    createdAt: u.createdAt,
  };
}

function assertActive(user: { status: string }): void {
  if (user.status !== "ACTIVE") {
    throw new AppError(403, "ACCOUNT_DISABLED", "This account is suspended or deleted");
  }
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// ─── Email + password ────────────────────────────────────────────────────────

export async function register(input: RegisterInput): Promise<PublicUser> {
  const [emailTaken, usernameTaken] = await Promise.all([
    prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    prisma.user.findUnique({ where: { username: input.username }, select: { id: true } }),
  ]);
  if (emailTaken) throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
  if (usernameTaken) throw new AppError(409, "USERNAME_TAKEN", "This username is taken");

  const passwordHash = await hashPassword(input.password);

  let user: UserRow;
  try {
    user = await prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        passwordHash,
        profile: { create: { displayName: input.displayName } },
        settings: { create: {} },
        memberships: personalWorkspaceMembership(input.displayName),
      },
      select: publicUserSelect,
    });
  } catch (err) {
    // Two sign-ups for the same email/username at the same moment: the database catches it.
    if (isUniqueViolation(err)) throw new AppError(409, "ACCOUNT_EXISTS", "Email or username is already taken");
    throw err;
  }

  const token = await createVerificationToken(user.id, "EMAIL_VERIFY");
  await sendVerificationEmail(user.email, token);
  return toPublicUser(user);
}

export async function login(input: LoginInput): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { ...publicUserSelect, passwordHash: true },
  });

  if (!user?.passwordHash) {
    await dummyVerify(input.password);
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  assertActive(user);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return toPublicUser(user);
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id }, select: publicUserSelect });
  if (!user) throw new AppError(401, "INVALID_TOKEN", "Account no longer exists");
  assertActive(user);
  return toPublicUser(user);
}

// ─── Email verification ──────────────────────────────────────────────────────

export async function verifyEmail(token: string): Promise<void> {
  const userId = await consumeVerificationToken(token, "EMAIL_VERIFY");
  await prisma.user.updateMany({
    where: { id: userId, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
}

export async function resendVerification(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user) throw new AppError(401, "INVALID_TOKEN", "Account no longer exists");
  if (user.emailVerifiedAt) throw new AppError(400, "ALREADY_VERIFIED", "Email is already verified");

  const token = await createVerificationToken(userId, "EMAIL_VERIFY");
  await sendVerificationEmail(user.email, token);
}

// ─── Password reset ──────────────────────────────────────────────────────────

/** Always succeeds from the caller's point of view, so it can't be used to discover accounts. */
export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, status: true } });
  if (!user || user.status !== "ACTIVE") return;

  const token = await createVerificationToken(user.id, "PASSWORD_RESET");
  await sendPasswordResetEmail(user.email, token);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const userId = await consumeVerificationToken(token, "PASSWORD_RESET");
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  // Receiving the reset email proves the user controls the address.
  await prisma.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  await revokeAllForUser(userId);
}

// ─── Google ──────────────────────────────────────────────────────────────────

function usernameFromEmail(email: string): string {
  const base = (email.split("@")[0] ?? "user").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";
  return `${base}_${randomBytes(3).toString("hex")}`;
}

export async function loginWithGoogle(profile: GoogleProfile): Promise<PublicUser> {
  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: "google", providerAccountId: profile.sub } },
    select: { user: { select: publicUserSelect } },
  });
  if (linked) {
    assertActive(linked.user);
    return toPublicUser(linked.user);
  }

  const existing = await prisma.user.findUnique({ where: { email: profile.email }, select: publicUserSelect });
  if (existing) {
    // Only link by email when Google has verified it; otherwise someone could claim another person's account.
    if (!profile.emailVerified) {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists; sign in with your password");
    }
    assertActive(existing);
    await prisma.oAuthAccount.create({
      data: { userId: existing.id, provider: "google", providerAccountId: profile.sub },
    });
    if (!existing.emailVerifiedAt) {
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date() } });
    }
    return getUserById(existing.id);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const displayName = (profile.name ?? profile.email.split("@")[0] ?? "User").slice(0, 50);
      const user = await prisma.user.create({
        data: {
          email: profile.email,
          username: usernameFromEmail(profile.email),
          emailVerifiedAt: profile.emailVerified ? new Date() : null,
          profile: { create: { displayName } },
          settings: { create: {} },
          oauthAccounts: { create: { provider: "google", providerAccountId: profile.sub } },
          memberships: personalWorkspaceMembership(displayName),
        },
        select: publicUserSelect,
      });
      return toPublicUser(user);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // retry only on a generated-username collision
    }
  }
  throw new AppError(500, "INTERNAL_ERROR", "Could not create account");
}
