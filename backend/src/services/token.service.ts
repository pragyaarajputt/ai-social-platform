import { randomUUID } from "node:crypto";
import { errors, jwtVerify, SignJWT } from "jose";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import type { Role, TokenType } from "../generated/prisma/enums.js";
import { AppError } from "../utils/AppError.js";
import { generateToken, hashToken } from "../utils/crypto.js";

const ISSUER = "ai-social-api";
const AUDIENCE = "ai-social-web";
const accessKey = new TextEncoder().encode(env.jwtAccessSecret);

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

// ─── Access tokens (JWT) ─────────────────────────────────────────────────────

export function signAccessToken(user: { id: string; role: Role }): Promise<string> {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.accessTokenTtlSeconds}s`)
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<{ id: string; role: Role }> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (!payload.sub || typeof payload.role !== "string") throw new Error("malformed token");
    return { id: payload.sub, role: payload.role as Role };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new AppError(401, "TOKEN_EXPIRED", "Access token has expired");
    }
    throw new AppError(401, "INVALID_TOKEN", "Access token is invalid");
  }
}

// ─── Refresh tokens (opaque, rotated) ────────────────────────────────────────

/** Creates a refresh token. Pass familyId to continue an existing login; omit it to start a new one. */
export async function issueRefreshToken(
  userId: string,
  meta: ClientMeta,
  familyId: string = randomUUID(),
): Promise<string> {
  const token = generateToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000),
      userAgent: meta.userAgent?.slice(0, 500),
      ip: meta.ip,
    },
  });
  return token;
}

/**
 * Swaps a refresh token for a new one in the same family.
 * Presenting an already-used token means it was probably stolen, so the whole family is revoked.
 */
export async function rotateRefreshToken(token: string, meta: ClientMeta): Promise<{ userId: string; token: string }> {
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!existing) throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid");

  if (existing.revokedAt) {
    await revokeFamily(existing.familyId);
    throw new AppError(401, "REFRESH_TOKEN_REUSED", "Refresh token was already used; please sign in again");
  }
  if (existing.expiresAt <= new Date()) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token has expired");
  }

  const newToken = generateToken();
  const rotated = await prisma.$transaction(async (tx) => {
    // Conditional update: if a concurrent request already rotated this token, count is 0.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return false;

    const created = await tx.refreshToken.create({
      data: {
        userId: existing.userId,
        familyId: existing.familyId,
        tokenHash: hashToken(newToken),
        expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000),
        userAgent: meta.userAgent?.slice(0, 500),
        ip: meta.ip,
      },
    });
    await tx.refreshToken.update({ where: { id: existing.id }, data: { replacedById: created.id } });
    return true;
  });

  if (!rotated) {
    await revokeFamily(existing.familyId);
    throw new AppError(401, "REFRESH_TOKEN_REUSED", "Refresh token was already used; please sign in again");
  }
  return { userId: existing.userId, token: newToken };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ─── Single-use verification tokens (email verify, password reset) ──────────

const verificationTtlMs: Record<TokenType, number> = {
  EMAIL_VERIFY: 24 * 3_600_000,
  PASSWORD_RESET: 3_600_000,
};

/** Creates a token and invalidates any earlier unused token of the same type for this user. */
export async function createVerificationToken(userId: string, type: TokenType): Promise<string> {
  const token = generateToken();
  await prisma.$transaction([
    prisma.verificationToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.verificationToken.create({
      data: {
        userId,
        type,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + verificationTtlMs[type]),
      },
    }),
  ]);
  return token;
}

/** Marks the token used and returns its user. Throws if it's unknown, expired, used, or the wrong type. */
export async function consumeVerificationToken(token: string, type: TokenType): Promise<string> {
  const tokenHash = hashToken(token);
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash } });

  const { count } = await prisma.verificationToken.updateMany({
    where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (!record || count === 0) {
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "This link is invalid or has expired");
  }
  return record.userId;
}
