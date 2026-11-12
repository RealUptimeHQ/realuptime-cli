import type { ParsedArgs } from "../args.ts";
import { flagList, flagNumber, requireFlagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";

export function checksList(client: ClientConfig): Promise<unknown> {
  return apiRequest(client, { path: "/checks" });
}

/** `POST /checks` -- an http monitor is the only type this API can create
 * (docs/api.md "POST /checks"); every field the CLI accepts here maps
 * straight onto `checkCreateShape` (packages/db/api-schemas.ts). */
export function checksCreate(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const body: Record<string, unknown> = {
    name: requireFlagString(flags, "name"),
    url: requireFlagString(flags, "url"),
  };
  const interval = flagNumber(flags, "interval");
  if (interval !== undefined) body.intervalSeconds = interval;
  const regions = flagList(flags, "regions");
  if (regions !== undefined) body.regions = regions;
  return apiRequest(client, { method: "POST", path: "/checks", body });
}

export async function checksDelete(client: ClientConfig, id: string | undefined): Promise<unknown> {
  if (!id) {
    throw new CliError("Usage: realuptime checks delete <id>");
  }
  await apiRequest(client, { method: "DELETE", path: `/checks/${encodeURIComponent(id)}` });
  return { deleted: id };
}

/** `GET /checks/:id/runs` (REA-1052): a heartbeat monitor's runs, newest
 * first. `--limit` is 1 to 500; the API clamps reads to the plan's window. */
export async function checksRuns(
  client: ClientConfig,
  id: string | undefined,
  flags: ParsedArgs["flags"],
): Promise<unknown> {
  if (!id) {
    throw new CliError("Usage: realuptime checks runs <id> [--limit <n>]");
  }
  const limit = flagNumber(flags, "limit");
  const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
  return apiRequest(client, { path: `/checks/${encodeURIComponent(id)}/runs${query}` });
}
