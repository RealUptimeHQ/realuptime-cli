import { CliError } from "./errors.ts";

export const DEFAULT_API_URL = "https://realuptime.io/api/v1";

/** Node 22 ships a global `fetch` -- this alias exists only so a test can
 * inject a stub matching the exact shape this file calls, without this
 * module (or any command module) importing a mocking library. */
export type FetchLike = typeof fetch;

export interface ClientConfig {
  apiUrl: string;
  apiKey?: string;
  fetchImpl: FetchLike;
}

export type QueryValue = string | number | boolean | undefined;

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** `false` for the one keyless route (`GET /outages/:slug`) -- every other
   * command requires a key and refuses locally, before making a request, if
   * one was never configured. Defaults to `true`. */
  auth?: boolean;
}

/** The `{ error, code, docs }` envelope every v1 refusal answers with
 * (apps/web/lib/api-auth.ts's `apiAuthErrorResponse`, and every route's own
 * literal error responses). Not every field is always present -- see that
 * file's own comment -- so all three stay optional here. */
interface ApiErrorBody {
  error?: string;
  code?: string;
  docs?: string;
}

export function buildUrl(apiUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(apiUrl.replace(/\/+$/, "") + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * The one HTTP call site every command goes through (REA-180). A non-2xx
 * response is turned into a `CliError` carrying the API's own `error`
 * message, `code`, and `docs` link untouched -- this function never
 * rewrites or summarizes a server-side refusal, matching docs/api.md's
 * "CLI" section.
 */
export async function apiRequest<T>(config: ClientConfig, options: ApiRequestOptions): Promise<T> {
  const requiresAuth = options.auth !== false;
  if (requiresAuth && !config.apiKey) {
    throw new CliError("No API key configured. Pass --api-key or set REALUPTIME_API_KEY.");
  }

  const url = buildUrl(config.apiUrl, options.path, options.query);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (requiresAuth) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  let response: Response;
  try {
    response = await config.fetchImpl(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`Could not reach ${config.apiUrl}: ${message}`);
  }

  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      // A non-JSON body (an upstream proxy error page, most likely) --
      // handled below by the `!response.ok` branch, which falls back to
      // the raw HTTP status when there's no `error` field to read.
      json = null;
    }
  }

  if (!response.ok) {
    const body = (json ?? {}) as ApiErrorBody;
    throw new CliError(body.error ?? `Request failed with status ${response.status}.`, {
      code: body.code,
      docs: body.docs,
      httpStatus: response.status,
    });
  }

  return json as T;
}
