"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { requestPasswordReset } from "@/lib/auth";
import { applyServerError } from "@/lib/form-errors";
import { forgotPasswordSchema, type ForgotPasswordValues } from "@/lib/schemas";
import { AuthCard } from "./AuthCard";

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({ resolver: zodResolver(forgotPasswordSchema) });

  async function onSubmit(values: ForgotPasswordValues) {
    try {
      await requestPasswordReset(values.email);
      setSentTo(values.email);
    } catch (err) {
      applyServerError(err, setError, ["email"]);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
      footer={
        <Link href="/login" className="hover:underline">
          Back to log in
        </Link>
      }
    >
      {sentTo ? (
        <Alert tone="success">
          If an account exists for <strong>{sentTo}</strong>, a reset link is on its way. It expires in 1 hour.
        </Alert>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          {errors.root?.server ? <Alert tone="error">{errors.root.server.message}</Alert> : null}
          <FormField label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
          <Button type="submit" loading={isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
