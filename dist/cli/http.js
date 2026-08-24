import { CliError } from "./errors.js";
export const DEFAULT_API_URL = "https://realuptime.io/api/v1";
export function buildUrl(apiUrl, path, query) {
    const url = new URL(apiUrl.replace(/\/+$/, "") + path);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined)
                continue;
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
export async function apiRequest(config, options) {
    const requiresAuth = options.auth !== false;
    if (requiresAuth && !config.apiKey) {
        throw new CliError("No API key configured. Pass --api-key or set REALUPTIME_API_KEY.");
    }
    const url = buildUrl(config.apiUrl, options.path, options.query);
    const headers = { "Content-Type": "application/json" };
    if (requiresAuth) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }
    let response;
    try {
        response = await config.fetchImpl(url, {
            method: options.method ?? "GET",
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new CliError(`Could not reach ${config.apiUrl}: ${message}`);
    }
    const text = await response.text();
    let json = null;
    if (text.length > 0) {
        try {
            json = JSON.parse(text);
        }
        catch {
            // A non-JSON body (an upstream proxy error page, most likely) --
            // handled below by the `!response.ok` branch, which falls back to
            // the raw HTTP status when there's no `error` field to read.
            json = null;
        }
    }
    if (!response.ok) {
        const body = (json ?? {});
        throw new CliError(body.error ?? `Request failed with status ${response.status}.`, {
            code: body.code,
            docs: body.docs,
            httpStatus: response.status,
        });
    }
    return json;
}
