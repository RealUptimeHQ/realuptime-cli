import type { ParsedArgs } from "../args.ts";
import { requireFlagString } from "../args.ts";
import { apiRequest, type ClientConfig } from "../http.ts";

/** `POST /agents`: registers one server agent. The response's `token` is an
 * account credential and is returned this once; `--field token` prints it
 * alone, for capturing into an environment variable. */
export function agentTokenCreate(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  return apiRequest(client, { method: "POST", path: "/agents", body: { name: requireFlagString(flags, "name") } });
}
