import type { ParsedArgs } from "./args.ts";
import { flagBoolean, flagString } from "./args.ts";
import { DEFAULT_API_URL } from "./http.ts";

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
  json: boolean;
}

/**
 * `--api-key`/`REALUPTIME_API_KEY` and `--api-url`/`REALUPTIME_API_URL`
 * (docs/api.md "CLI") -- the flag always wins over the environment variable,
 * matching every other CLI's precedent for this pair. `env` is a parameter
 * (not read from `process.env` directly) purely so tests can pass a clean
 * object instead of depending on, or mutating, the real process environment.
 */
export function resolveConfig(flags: ParsedArgs["flags"], env: Record<string, string | undefined>): CliConfig {
  return {
    apiUrl: flagString(flags, "api-url") ?? env.REALUPTIME_API_URL ?? DEFAULT_API_URL,
    apiKey: flagString(flags, "api-key") ?? env.REALUPTIME_API_KEY,
    json: flagBoolean(flags, "json"),
  };
}
