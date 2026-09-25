import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { ApiError } from "./api-error";

/** Server error codes that belong to a specific field. */
const codeToField: Record<string, string> = {
  EMAIL_TAKEN: "email",
  USERNAME_TAKEN: "username",
};

/**
 * Shows an API error on the form: next to the field when the server says which field is wrong,
 * otherwise as a form-level message (errors.root.server).
 */
export function applyServerError<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>, fields: string[]): void {
  if (!(err instanceof ApiError)) {
    setError("root.server", { message: "Something went wrong. Try again." });
    return;
  }

  let placed = false;
  for (const { field, message } of err.fieldErrors) {
    if (fields.includes(field)) {
      setError(field as Path<T>, { message });
      placed = true;
    }
  }
  const field = codeToField[err.code];
  if (field && fields.includes(field)) {
    setError(field as Path<T>, { message: err.message });
    placed = true;
  }
  if (!placed) setError("root.server", { message: err.message });
}
