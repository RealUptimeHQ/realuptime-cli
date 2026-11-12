import type { ParsedArgs } from "../args.ts";
import { flagList, flagString, requireFlagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";

/** `POST /maintenance` -- exactly one of `--duration-minutes`/`--ends-at` is
 * required (docs/api.md "POST /maintenance"); `--starts-at` defaults to now
 * server-side when omitted. */
export function maintenanceStart(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const durationMinutes = flagString(flags, "duration-minutes");
  const body: Record<string, unknown> = {
    statusPageId: requireFlagString(flags, "status-page-id"),
    title: requireFlagString(flags, "title"),
    body: requireFlagString(flags, "body"),
  };
  const startsAt = flagString(flags, "starts-at");
  if (startsAt !== undefined) body.startsAt = startsAt;
  const endsAt = flagString(flags, "ends-at");
  if (endsAt !== undefined) body.endsAt = endsAt;
  if (durationMinutes !== undefined) body.durationMinutes = Number(durationMinutes);
  const componentIds = flagList(flags, "component-ids");
  if (componentIds !== undefined) body.componentIds = componentIds;
  return apiRequest(client, { method: "POST", path: "/maintenance", body });
}

/** `DELETE /maintenance/:id` -- ends an active window early. */
export function maintenanceEnd(client: ClientConfig, id: string | undefined): Promise<unknown> {
  if (!id) {
    throw new CliError("Usage: realuptime maintenance end <id>");
  }
  return apiRequest(client, { method: "DELETE", path: `/maintenance/${encodeURIComponent(id)}` });
}

/** `GET /maintenance?statusPageId=...` -- the window active right now, or null. */
export function maintenanceStatus(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  return apiRequest(client, {
    path: "/maintenance",
    query: { statusPageId: requireFlagString(flags, "status-page-id") },
  });
}
