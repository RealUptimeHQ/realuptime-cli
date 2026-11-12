import { flagNumber, flagString, requireFlagString } from "../args.js";
import { apiRequest } from "../http.js";
/** `GET /heartbeats`. Never a ping URL: it is shown once, at creation. */
export function heartbeatsList(client) {
    return apiRequest(client, { path: "/heartbeats" });
}
/** `POST /heartbeats`. The response's `pingUrl` carries the monitor's token
 * and is returned this once; `--field pingUrl` prints it alone. */
export function heartbeatsCreate(client, flags) {
    const body = { name: requireFlagString(flags, "name") };
    const interval = flagNumber(flags, "interval");
    if (interval !== undefined)
        body.intervalSeconds = interval;
    const grace = flagNumber(flags, "grace");
    if (grace !== undefined)
        body.graceSeconds = grace;
    const statusPageId = flagString(flags, "status-page-id");
    if (statusPageId !== undefined)
        body.statusPageId = statusPageId;
    return apiRequest(client, { method: "POST", path: "/heartbeats", body });
}
