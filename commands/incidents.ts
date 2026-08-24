import type { ParsedArgs } from "../args.ts";
import { flagBoolean, flagNumber, requireFlagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";

export function incidentsList(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const limit = flagNumber(flags, "limit");
  return apiRequest(client, { path: "/incidents", query: { limit } });
}

/** `POST /incidents` -- `statusPageId` stays required, deliberately
 * (docs/api.md "POST /incidents"). */
export function incidentsCreate(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const body = {
    statusPageId: requireFlagString(flags, "status-page-id"),
    checkId: requireFlagString(flags, "check-id"),
    region: requireFlagString(flags, "region"),
    title: requireFlagString(flags, "title"),
    body: requireFlagString(flags, "body"),
  };
  return apiRequest(client, { method: "POST", path: "/incidents", body });
}

/** `POST /incidents/:id/updates` -- `--force` resolves over a live outage
 * without the confirmation the API otherwise asks for (docs/api.md
 * "Resolving while the monitor is still failing"). */
export function incidentsUpdate(client: ClientConfig, id: string | undefined, flags: ParsedArgs["flags"]): Promise<unknown> {
  if (!id) {
    throw new CliError("Usage: realuptime incidents update <id> --status <status> --body <body> [--force]");
  }
  const body: Record<string, unknown> = {
    status: requireFlagString(flags, "status"),
    body: requireFlagString(flags, "body"),
  };
  if (flagBoolean(flags, "force")) body.force = true;
  return apiRequest(client, { method: "POST", path: `/incidents/${encodeURIComponent(id)}/updates`, body });
}
