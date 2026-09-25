import nodemailer from "nodemailer";
import { env } from "../config/env.js";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Emails "sent" during tests, so tests can read the links. Only filled when NODE_ENV=test. */
export const testOutbox: Email[] = [];

const transport = env.smtpUrl ? nodemailer.createTransport(env.smtpUrl) : undefined;

async function send(email: Email): Promise<void> {
  if (env.isTest) {
    testOutbox.push(email);
    return;
  }
  if (!transport) {
    // No SMTP configured: print to the console so links can be used in development.
    console.log(`\n── Email (not sent, no SMTP_URL) ──\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n──────────\n`);
    return;
  }
  await transport.sendMail({ from: env.emailFrom, ...email });
}

export function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${env.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: "Verify your email",
    text: `Welcome! Confirm your email address by opening this link:\n\n${link}\n\nThe link expires in 24 hours.`,
  });
}

export function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: "Reset your password",
    text: `Someone asked to reset your password. If that was you, open this link:\n\n${link}\n\nThe link expires in 1 hour. If you didn't ask for this, you can ignore this email.`,
  });
}

/** Sent once, about a day ahead, when a scheduled post will probably fail. */
export function sendScheduledPostWarning(
  to: string,
  warning: { postId: string; caption: string; scheduledAt: Date; problems: string[] },
): Promise<void> {
  const link = `${env.appUrl}/posts/${warning.postId}`;
  const excerpt = warning.caption.length > 80 ? `${warning.caption.slice(0, 80)}…` : warning.caption || "(no caption)";
  return send({
    to,
    subject: "A scheduled post needs your attention",
    text:
      `Your post scheduled for ${warning.scheduledAt.toUTCString()} will probably fail:\n\n` +
      warning.problems.map((p) => `  • ${p}`).join("\n") +
      `\n\n"${excerpt}"\n\nFix it here: ${link}`,
  });
}
