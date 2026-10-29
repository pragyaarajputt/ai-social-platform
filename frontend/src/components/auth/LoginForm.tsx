"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { login, safeNextPath } from "@/lib/auth";
import { applyServerError } from "@/lib/form-errors";
import { loginSchema, type LoginValues } from "@/lib/schemas";
import { AuthCard } from "./AuthCard";
import { GoogleButton } from "./GoogleButton";
import { RedirectIfAuthenticated } from "./RequireAuth";

/** Messages for the ?error= the API adds when Google sign-in sends the browser back here. */
const queryMessages: Record<string, string> = {
  oauth_failed: "Google sign-in didn't work. Try again, or use your email and password.",
  google_unavailable: "Google sign-in isn't set up on this server yet. Use your email and password.",
  google_cancelled: "Google sign-in was cancelled. Nothing was changed.",
  google_expired: "That Google sign-in took too long or was finished in another browser. Please try again.",
  google_email_taken: "An account with this email already exists, and Google hasn't verified the address. Sign in with your password.",
  account_disabled: "This account is suspended or deleted.",
};

export function LoginForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const queryError = queryMessages[params.get("error") ?? ""];

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(values: LoginValues) {
    try {
      await login(values); // RedirectIfAuthenticated navigates to `next`
    } catch (err) {
      applyServerError(err, setError, ["email", "password"]);
    }
  }

  return (
    <RedirectIfAuthenticated to={next}>
      <AuthCard
        title="Log in"
        subtitle="Welcome back."
        footer={
          <>
            New here?{" "}
            <Link href={next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`} className="font-medium text-foreground hover:underline">
              Create an account
            </Link>
          </>
        }
      >
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          {queryError ? <Alert tone="error">{queryError}</Alert> : null}
          {errors.root?.server ? <Alert tone="error">{errors.root.server.message}</Alert> : null}
          <FormField label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
          <FormField
            label="Password"
            type="password"
            autoComplete="current-password"
            error={errors.password?.message}
            {...register("password")}
          />
          <div className="-mt-2 text-right text-sm">
            <Link href="/forgot-password" className="text-neutral-500 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Button type="submit" loading={isSubmitting}>
            Log in
          </Button>
        </form>
        <div className="my-4 flex items-center gap-3 text-xs text-neutral-500">
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          or
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </div>
        <GoogleButton next={next} />
      </AuthCard>
    </RedirectIfAuthenticated>
  );
}
