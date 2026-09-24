import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import { authLimiter, loginLimiter, resendVerificationLimiter } from "../middleware/rateLimits.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "../schemas/auth.schemas.js";

export const authRouter = Router();

authRouter.post("/register", authLimiter, validateBody(registerSchema), auth.register);
authRouter.post("/login", loginLimiter, validateBody(loginSchema), auth.login);
authRouter.post("/refresh", auth.refresh);
authRouter.post("/logout", auth.logout);
authRouter.post("/logout-all", requireAuth, auth.logoutAll);
authRouter.get("/me", requireAuth, auth.me);

authRouter.post("/verify-email", authLimiter, validateBody(verifyEmailSchema), auth.verifyEmail);
authRouter.post("/resend-verification", requireAuth, resendVerificationLimiter, auth.resendVerification);
authRouter.post("/forgot-password", authLimiter, validateBody(forgotPasswordSchema), auth.forgotPassword);
authRouter.post("/reset-password", authLimiter, validateBody(resetPasswordSchema), auth.resetPassword);

authRouter.get("/google", auth.googleStart);
authRouter.get("/google/callback", auth.googleCallback);
