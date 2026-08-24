import { flagBoolean, flagString } from "./args.js";
import { DEFAULT_API_URL } from "./http.js";
/**
 * `--api-key`/`REALUPTIME_API_KEY` and `--api-url`/`REALUPTIME_API_URL`
 * (docs/api.md "CLI") -- the flag always wins over the environment variable,
 * matching every other CLI's precedent for this pair. `env` is a parameter
 * (not read from `process.env` directly) purely so tests can pass a clean
 * object instead of depending on, or mutating, the real process environment.
 */
export function resolveConfig(flags, env) {
    return {
        apiUrl: flagString(flags, "api-url") ?? env.REALUPTIME_API_URL ?? DEFAULT_API_URL,
        apiKey: flagString(flags, "api-key") ?? env.REALUPTIME_API_KEY,
        json: flagBoolean(flags, "json"),
    };
}
