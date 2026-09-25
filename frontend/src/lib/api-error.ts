export interface FieldError {
  field: string;
  message: string;
}

/** An error response from the API, in the backend's `{ error: { code, message, details } }` shape. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field-level validation errors, when the server returned them. */
  get fieldErrors(): FieldError[] {
    return Array.isArray(this.details) ? (this.details as FieldError[]) : [];
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error?.code) {
      return new ApiError(res.status, body.error.code, body.error.message ?? "Request failed", body.error.details);
    }
  } catch {
    // Not JSON (e.g. the API is down and the proxy returned an HTML error page).
  }
  return new ApiError(
    res.status,
    res.status >= 500 ? "SERVER_UNAVAILABLE" : "REQUEST_FAILED",
    res.status >= 500 ? "The server is unavailable. Try again in a moment." : "Request failed",
  );
}
