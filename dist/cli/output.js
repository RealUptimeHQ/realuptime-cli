import { CliError } from "./errors.js";
/** The array-valued keys a list response might carry, in the order tried --
 * matches the wrapper key each v1 list route actually uses (docs/api.md). */
const LIST_KEYS = ["checks", "incidents", "statusPages", "issues", "components", "heartbeats", "projects"];
/** The single-entity keys a create/update/get response might carry. */
const ENTITY_KEYS = ["check", "incident", "update", "statusPage", "component", "channel"];
/** The responses that carry a value shown once: the entity it belongs to,
 * the field holding it, and what to call it. `also` names further values the
 * same response carries once (an Errors project's Sentry-shaped DSN). */
const SHOWN_ONCE = [
    { entity: "project", field: "dsn", label: "DSN", also: [{ field: "sentryDsn", label: "Sentry DSN" }] },
    { entity: "heartbeat", field: "pingUrl", label: "Ping URL" },
    { entity: "agent", field: "token", label: "Agent token" },
];
/**
 * `--field <path>`: one value of the response, as plain text, and nothing
 * else. A dotted path walks into objects (`statusPage.id`). A path that names
 * nothing is an error rather than an empty line, so a script capturing the
 * value fails loudly instead of carrying on with an empty variable.
 */
export function renderField(data, path) {
    let value = data;
    for (const key of path.split(".")) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
            throw new CliError(`The response has no field "${path}".`);
        }
        value = value[key];
    }
    if (value === null || value === undefined)
        throw new CliError(`The response has no field "${path}".`);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}
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
    // A value shown once: the entity's summary line, then the value under a
    // label that says it will not be shown again.
    for (const { entity, field, label, also } of SHOWN_ONCE) {
        const row = obj[entity];
        if (row && typeof row === "object" && typeof obj[field] === "string") {
            const lines = [summarizeRow(row), `${label} (shown once, store it now): ${obj[field]}`];
            for (const extra of also ?? []) {
                if (typeof obj[extra.field] === "string") {
                    lines.push(`${extra.label} (shown once, store it now): ${obj[extra.field]}`);
                }
            }
            if (typeof obj.installCommand === "string") {
                lines.push(`Install, on the server, with the token exported as REALUPTIME_AGENT_TOKEN: ${obj.installCommand}`);
            }
            return lines.join("\n");
        }
    }
    // `channels list`: the two built-in destinations, then the registry.
    if (Array.isArray(obj.channels) && Array.isArray(obj.builtIn)) {
        return [...obj.builtIn, ...obj.channels].map((row) => summarizeRow(row)).join("\n");
    }
    // `channels test`: what the destination answered.
    if (typeof obj.ok === "boolean" && obj.channel && typeof obj.channel === "object") {
        const row = summarizeRow(obj.channel);
        return obj.ok ? `Test alert accepted. ${row}` : `Test alert refused: ${obj.error ?? "no reason given"}. ${row}`;
    }
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
    // `errors issues resolve|ignore|reopen`: the updated issue's one-line
    // summary, not the release breakdown and occurrences that ride along in the
    // response (`--json` still prints all of it).
    if (obj.issue && typeof obj.issue === "object" && Array.isArray(obj.occurrences)) {
        return summarizeRow(obj.issue);
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
    // No known shape (outage readings, the endpoint index) -- full JSON is still the honest default rather than a
    // hand-picked field subset that might hide the field the caller wanted.
    return JSON.stringify(data, null, 2);
}
/** A compact one-line summary: the fields most useful to scan across a list,
 * present only when the row actually has them. Falls back to the row's full
 * JSON if none of these fields are present, so a shape this function
 * doesn't specifically know about is still shown, not dropped. */
function summarizeRow(row) {
    const fields = [
        "id",
        "name",
        "display_name",
        "slug",
        "public_url",
        "title",
        "status",
        "url",
        "region",
        "type",
        "check_id",
        "config_summary",
        "active",
        "keyHint",
        "heartbeat_state",
    ];
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
