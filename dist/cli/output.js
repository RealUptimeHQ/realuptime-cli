import { CliError } from "./errors.js";
/** The array-valued keys a list response might carry, in the order tried --
 * matches the wrapper key each v1 list route actually uses (docs/api.md). */
const LIST_KEYS = ["checks", "incidents", "statusPages", "issues"];
/** The single-entity keys a create/update/get response might carry. */
const ENTITY_KEYS = ["check", "incident", "update"];
/** Renders a command's result for a human terminal, or the raw JSON when
 * `--json` was passed. `--json` output is ALWAYS the untouched API response
 * (or, for a delete, `{ "deleted": "<id>" }`) -- never reshaped -- so a
 * script piping this CLI gets exactly what the REST API itself returns. */
export function render(data, opts) {
    if (opts.json) {
        return JSON.stringify(data, null, 2);
    }
    return renderHuman(data);
}
function renderHuman(data) {
    if (data === null || data === undefined)
        return "OK";
    if (typeof data !== "object")
        return String(data);
    const obj = data;
    for (const key of LIST_KEYS) {
        const list = obj[key];
        if (Array.isArray(list)) {
            if (list.length === 0)
                return `No ${key}.`;
            return list.map((row) => summarizeRow(row)).join("\n");
        }
    }
    for (const key of ENTITY_KEYS) {
        const entity = obj[key];
        if (entity && typeof entity === "object") {
            return summarizeRow(entity);
        }
    }
    if (typeof obj.deleted === "string") {
        return `Deleted ${obj.deleted}.`;
    }
    // `errors sourcemaps upload` (REA-254): the local upload summary, not an
    // API response shape. One line per file (name and content hash, so two
    // runs over the same build are visibly the same upload), then the server's
    // own stored/replaced counts.
    if (Array.isArray(obj.files) && typeof obj.release === "string" && (typeof obj.uploaded === "number" || obj.dryRun === true)) {
        const files = obj.files;
        const lines = files.map((file) => `  ${file.name}  ${file.bytes} bytes  sha256 ${file.sha256.slice(0, 12)}`);
        if (obj.dryRun === true) {
            return [`Dry run: ${files.length} source map${files.length === 1 ? "" : "s"} for release ${obj.release}, nothing uploaded.`, ...lines].join("\n");
        }
        return [
            `Uploaded ${obj.uploaded} source map${obj.uploaded === 1 ? "" : "s"} for release ${obj.release}: stored ${obj.stored}, replaced ${obj.replaced}.`,
            ...lines,
        ].join("\n");
    }
    // No known shape (status-pages, outage readings, error projects/issues, the
    // endpoint index) -- full JSON is still the honest default rather than a
    // hand-picked field subset that might hide the field the caller wanted.
    return JSON.stringify(data, null, 2);
}
/** A compact one-line summary: the fields most useful to scan across a list,
 * present only when the row actually has them. Falls back to the row's full
 * JSON if none of these fields are present, so a shape this function
 * doesn't specifically know about is still shown, not dropped. */
function summarizeRow(row) {
    const fields = ["id", "name", "slug", "title", "status", "url", "region", "type"];
    const parts = fields.filter((field) => row[field] !== undefined && row[field] !== null).map((field) => `${field}=${row[field]}`);
    return parts.length > 0 ? parts.join(" ") : JSON.stringify(row);
}
/** Renders whatever `runCli` caught into the line printed on stderr --
 * always the API's own message plus its RU- code and KB link when a
 * `CliError` carries them, never a generic "something went wrong". */
export function renderError(err) {
    if (err instanceof CliError) {
        const parts = [err.code ? `${err.message} [${err.code}]` : err.message];
        if (err.docs)
            parts.push(err.docs);
        return parts.join("\n");
    }
    return err instanceof Error ? err.message : String(err);
}
