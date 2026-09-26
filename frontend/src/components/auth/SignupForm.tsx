"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { safeNextPath, signup } from "@/lib/auth";
import { applyServerError } from "@/lib/form-errors";
import { signupSchema, type SignupValues } from "@/lib/schemas";
import { AuthCard } from "./AuthCard";
import { GoogleButton } from "./GoogleButton";
import { RedirectIfAuthenticated } from "./RequireAuth";

export function SignupForm() {
  // e.g. back to an invite after creating the account.
  const next = safeNextPath(useSearchParams().get("next"));
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({ resolver: zodResolver(signupSchema) });

  async function onSubmit(values: SignupValues) {
    try {
      await signup(values); // RedirectIfAuthenticated navigates to `next`
    } catch (err) {
      applyServerError(err, setError, ["email", "username", "displayName", "password"]);
    }
  }

  return (
    <RedirectIfAuthenticated to={next}>
      <AuthCard
        title="Create your account"
        subtitle="Write better posts with AI, from day one."
        footer={
          <>
            Already have an account?{" "}
            <Link href={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`} className="font-medium text-foreground hover:underline">
              Log in
            </Link>
          </>
        }
      >
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          {errors.root?.server ? <Alert tone="error">{errors.root.server.message}</Alert> : null}
          <FormField label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
          <FormField
            label="Username"
            autoComplete="username"
            hint="3–30 characters: letters, numbers and underscores."
            error={errors.username?.message}
            {...register("username")}
          />
          <FormField
            label="Display name"
            autoComplete="name"
            error={errors.displayName?.message}
            {...register("displayName")}
          />
          <FormField
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters."
            error={errors.password?.message}
            {...register("password")}
          />
          <Button type="submit" loading={isSubmitting}>
            Create account
          </Button>
        </form>
        <div className="my-4 flex items-center gap-3 text-xs text-neutral-500">
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          or
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </div>
        <GoogleButton />
      </AuthCard>
    </RedirectIfAuthenticated>
  );
}
