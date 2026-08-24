import { flagList, flagNumber, requireFlagString } from "../args.js";
import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
export function checksList(client) {
    return apiRequest(client, { path: "/checks" });
}
/** `POST /checks` -- an http monitor is the only type this API can create
 * (docs/api.md "POST /checks"); every field the CLI accepts here maps
 * straight onto `checkCreateShape` (packages/db/api-schemas.ts). */
export function checksCreate(client, flags) {
    const body = {
        name: requireFlagString(flags, "name"),
        url: requireFlagString(flags, "url"),
    };
    const interval = flagNumber(flags, "interval");
    if (interval !== undefined)
        body.intervalSeconds = interval;
    const regions = flagList(flags, "regions");
    if (regions !== undefined)
        body.regions = regions;
    return apiRequest(client, { method: "POST", path: "/checks", body });
}
export async function checksDelete(client, id) {
    if (!id) {
        throw new CliError("Usage: realuptime checks delete <id>");
    }
    await apiRequest(client, { method: "DELETE", path: `/checks/${encodeURIComponent(id)}` });
    return { deleted: id };
}
