import { ApiError, toApiError } from "./api-error";
import { getAccessToken, refreshSession } from "./auth-session";

export { ApiError } from "./api-error";

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Send the access token. Default true. */
  auth?: boolean;
}

/**
 * Calls the backend through the Next.js rewrite (/api/v1/* → Express).
 * If the access token has expired, refreshes once and retries the request.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await send(path, options);

  if (res.status === 401 && options.auth !== false) {
    const error = await toApiError(res);
    if (error.code !== "TOKEN_EXPIRED") throw error;

    const refreshed = await refreshSession();
    if (!refreshed) throw error;
    return parse<T>(await send(path, options));
  }
  return parse<T>(res);
}

function send(path: string, { method = "GET", body, auth = true }: ApiOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = auth ? getAccessToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  }).catch(() => {
    throw new ApiError(0, "NETWORK_ERROR", "Can't reach the server. Check your connection.");
  });
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
