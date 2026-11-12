import type { ParsedArgs } from "../args.ts";
import { flagString, requireFlagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";

export function statusPagesList(client: ClientConfig): Promise<unknown> {
  return apiRequest(client, { path: "/status-pages" });
}

/** `POST /status-pages`. `--slug` is optional: omitted, the API generates a
 * neutral one. The response's `public_url` is the page's address. */
export function statusPagesCreate(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const body: Record<string, unknown> = { name: requireFlagString(flags, "name") };
  const slug = flagString(flags, "slug");
  if (slug !== undefined) body.slug = slug;
  return apiRequest(client, { method: "POST", path: "/status-pages", body });
}

/** `GET /status-pages/:id`. */
export function statusPagesGet(client: ClientConfig, id: string | undefined): Promise<unknown> {
  if (!id) {
    throw new CliError("Usage: realuptime status-pages get <id>");
  }
  return apiRequest(client, { path: `/status-pages/${encodeURIComponent(id)}` });
}

/** `GET /status-pages/:id/components`. */
export function componentsList(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const pageId = requireFlagString(flags, "status-page-id");
  return apiRequest(client, { path: `/status-pages/${encodeURIComponent(pageId)}/components` });
}

/** `POST /status-pages/:id/components`: publish one of the account's checks
 * on the page. `--name` is the component's display name and defaults to the
 * check's own name. */
export function componentsAdd(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const pageId = requireFlagString(flags, "status-page-id");
  const body: Record<string, unknown> = { checkId: requireFlagString(flags, "check-id") };
  const displayName = flagString(flags, "name");
  if (displayName !== undefined) body.displayName = displayName;
  const description = flagString(flags, "description");
  if (description !== undefined) body.description = description;
  return apiRequest(client, {
    method: "POST",
    path: `/status-pages/${encodeURIComponent(pageId)}/components`,
    body,
  });
}
