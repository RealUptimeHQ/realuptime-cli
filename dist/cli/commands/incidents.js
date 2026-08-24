import { flagBoolean, flagNumber, requireFlagString } from "../args.js";
import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
export function incidentsList(client, flags) {
    const limit = flagNumber(flags, "limit");
    return apiRequest(client, { path: "/incidents", query: { limit } });
}
/** `POST /incidents` -- `statusPageId` stays required, deliberately
 * (docs/api.md "POST /incidents"). */
export function incidentsCreate(client, flags) {
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
export function incidentsUpdate(client, id, flags) {
    if (!id) {
        throw new CliError("Usage: realuptime incidents update <id> --status <status> --body <body> [--force]");
    }
    const body = {
        status: requireFlagString(flags, "status"),
        body: requireFlagString(flags, "body"),
    };
    if (flagBoolean(flags, "force"))
        body.force = true;
    return apiRequest(client, { method: "POST", path: `/incidents/${encodeURIComponent(id)}/updates`, body });
}
