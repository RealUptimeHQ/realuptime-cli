import { flagString, requireFlagString } from "../args.js";
import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
export function statusPagesList(client) {
    return apiRequest(client, { path: "/status-pages" });
}
/** `POST /status-pages`. `--slug` is optional: omitted, the API generates a
 * neutral one. The response's `public_url` is the page's address. */
export function statusPagesCreate(client, flags) {
    const body = { name: requireFlagString(flags, "name") };
    const slug = flagString(flags, "slug");
    if (slug !== undefined)
        body.slug = slug;
    return apiRequest(client, { method: "POST", path: "/status-pages", body });
}
/** `GET /status-pages/:id`. */
export function statusPagesGet(client, id) {
    if (!id) {
        throw new CliError("Usage: realuptime status-pages get <id>");
    }
    return apiRequest(client, { path: `/status-pages/${encodeURIComponent(id)}` });
}
/** `GET /status-pages/:id/components`. */
export function componentsList(client, flags) {
    const pageId = requireFlagString(flags, "status-page-id");
    return apiRequest(client, { path: `/status-pages/${encodeURIComponent(pageId)}/components` });
}
/** `POST /status-pages/:id/components`: publish one of the account's checks
 * on the page. `--name` is the component's display name and defaults to the
 * check's own name. */
export function componentsAdd(client, flags) {
    const pageId = requireFlagString(flags, "status-page-id");
    const body = { checkId: requireFlagString(flags, "check-id") };
    const displayName = flagString(flags, "name");
    if (displayName !== undefined)
        body.displayName = displayName;
    const description = flagString(flags, "description");
    if (description !== undefined)
        body.description = description;
    return apiRequest(client, {
        method: "POST",
        path: `/status-pages/${encodeURIComponent(pageId)}/components`,
        body,
    });
}
