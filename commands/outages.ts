import type { ParsedArgs } from "../args.ts";
import { flagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";

/**
 * `GET /outages/:slug` -- the one keyless command (docs/api.md "Outages
 * (keyless)"): `auth: false` means this never sends an Authorization header
 * and never requires `--api-key`/`REALUPTIME_API_KEY`, matching the public
 * per-service JSON endpoint it calls.
 */
export function outagesGet(client: ClientConfig, slug: string | undefined, flags: ParsedArgs["flags"]): Promise<unknown> {
  if (!slug) {
    throw new CliError("Usage: realuptime outages <slug> [--region iad|sjc|fra|nrt]");
  }
  const region = flagString(flags, "region");
  return apiRequest(client, {
    path: `/outages/${encodeURIComponent(slug)}`,
    query: { region },
    auth: false,
  });
}
