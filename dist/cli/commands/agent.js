import { requireFlagString } from "../args.js";
import { apiRequest } from "../http.js";
/** `POST /agents`: registers one server agent. The response's `token` is an
 * account credential and is returned this once; `--field token` prints it
 * alone, for capturing into an environment variable. */
export function agentTokenCreate(client, flags) {
    return apiRequest(client, { method: "POST", path: "/agents", body: { name: requireFlagString(flags, "name") } });
}
