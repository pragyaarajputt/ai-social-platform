import type { InputHTMLAttributes } from "react";
import { forwardRef, useId } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

/** Labelled input with an accessible error message. Works with react-hook-form's register(). */
export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(function FormField(
  { label, error, hint, id, className = "", ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        className={`h-10 rounded-lg border bg-transparent px-3 text-sm outline-none transition focus:ring-2 focus:ring-blue-500 ${
          error ? "border-red-500" : "border-neutral-300 dark:border-neutral-700"
        } ${className}`}
        {...props}
      />
      {error ? (
        <p id={messageId} className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-sm text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
