import { z } from "zod";

// These mirror the backend's rules (backend/src/schemas/auth.schemas.ts) so users see errors
// before submitting. The server still validates everything.

const email = z.string().trim().min(1, "Email is required").pipe(z.email("Enter a valid email address"));

const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

export const signupSchema = z.object({
  email,
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[A-Za-z0-9_]+$/, "Username can only contain letters, numbers and underscores"),
  displayName: z.string().trim().min(1, "Display name is required").max(50, "Display name is too long"),
  password: newPassword,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export type SignupValues = z.infer<typeof signupSchema>;
export type LoginValues = z.infer<typeof loginSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;
