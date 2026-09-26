import { z } from "zod";

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address").max(254));

// NIST SP 800-63B: length matters, composition rules don't. 128 caps hashing cost.
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

const username = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(30, "Username must be at most 30 characters")
      .regex(/^[a-z0-9_]+$/, "Username can only contain letters, numbers and underscores"),
  );

const token = z.string().min(1, "Token is required").max(200);

export const registerSchema = z.object({
  email,
  username,
  password,
  displayName: z.string().trim().min(1, "Display name is required").max(50),
});

export const loginSchema = z.object({
  email,
  // No length rules at login: old passwords shouldn't be rejected by newer rules.
  password: z.string().min(1, "Password is required").max(128),
});

export const verifyEmailSchema = z.object({ token });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({ token, password });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
