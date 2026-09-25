"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { resetPassword } from "@/lib/auth";
import { clearSession } from "@/lib/auth-session";
import { applyServerError } from "@/lib/form-errors";
import { resetPasswordSchema, type ResetPasswordValues } from "@/lib/schemas";
import { AuthCard } from "./AuthCard";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token");
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema) });

  async function onSubmit(values: ResetPasswordValues) {
    if (!token) return;
    try {
      await resetPassword(token, values.password);
      clearSession(); // the server has signed out every session
      setDone(true);
    } catch (err) {
      applyServerError(err, setError, ["password"]);
    }
  }

  if (!token) {
    return (
      <AuthCard title="Reset your password">
        <Alert tone="error">This reset link is incomplete. Open the link from your email again.</Alert>
        <p className="mt-4 text-center text-sm">
          <Link href="/forgot-password" className="hover:underline">
            Request a new link
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" subtitle="You'll be signed out on all devices.">
      {done ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">Your password has been changed.</Alert>
          <Link
            href="/login"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background"
          >
            Log in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          {errors.root?.server ? (
            <Alert tone="error">
              {errors.root.server.message}{" "}
              <Link href="/forgot-password" className="font-medium underline">
                Request a new link
              </Link>
            </Alert>
          ) : null}
          <FormField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters."
            error={errors.password?.message}
            {...register("password")}
          />
          <FormField
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            error={errors.confirmPassword?.message}
            {...register("confirmPassword")}
          />
          <Button type="submit" loading={isSubmitting}>
            Change password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
