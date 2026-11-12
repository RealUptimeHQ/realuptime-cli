import { parseYaml, YamlError } from "./yaml.js";
/**
 * The monitoring-as-code definition file (REA-246): what `realuptime apply`
 * reads and `realuptime export` writes.
 *
 * Field model: EXACTLY the REST API's own request fields, by name and by
 * rule -- a check in this file is the body `POST /checks` accepts
 * (`checkCreateShape` in packages/db/api-schemas.ts), nothing renamed,
 * nothing added. The Terraform provider (REA-226) is built on the same
 * schemas, so a definition file and a `.tf` resource describe a check with
 * the same words. `definition-drift.test.ts` pins this module's field list
 * and validation verdicts against the zod schemas themselves, so the two
 * can't quietly diverge; this file re-implements the rules by hand only
 * because the CLI is zero-dependency and can't import zod at runtime.
 *
 * Scope (v1): `checks` only. Status pages, components and notification
 * channels have write endpoints and their own commands (`status-pages
 * create`, `components add`, `channels create`), but they are not declared
 * here: a channel's credential is write-only, so a file could not be diffed
 * against the account, and email and Slack are one per account rather than
 * a list. Alert rules have no endpoint. A top-level key for any of them is
 * refused with a message saying what to use instead, rather than accepted
 * and silently ignored.
 */
export const DEFINITION_VERSION = 1;
/** The API's absolute interval bounds (`MIN_INTERVAL_SECONDS` and
 * `MAX_INTERVAL_SECONDS` in packages/db/checks.ts), pinned by
 * `definition-drift.test.ts`. The API refuses a value outside them with
 * RU-3006; the definition file refuses it before any request is made. */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86_400;
export const LIVE_REGIONS = ["iad", "sjc", "fra", "nrt", "ord", "yyz", "lhr", "sin", "syd", "gru"];
/** The server's default when a check specifies no regions: the core four,
 * NOT every live region -- ord/yyz are tier-gated (Pro/Business) and the
 * no-regions default must not imply regions a plan may not include. Mirrors
 * DEFAULT_CHECK_REGIONS in packages/db/checks.ts; the drift test pins both. */
export const DEFAULT_CHECK_REGIONS = ["iad", "sjc", "fra", "nrt"];
export const MAX_NAME_LENGTH = 200;
/** Every field `POST /checks` accepts, in `checkCreateShape` order. */
export const CHECK_FIELDS = [
    "name",
    "url",
    "intervalSeconds",
    "regions",
    "latencyThresholdMs",
    "assertionBodyOp",
    "assertionBodyValue",
    "assertionBodyCaseSensitive",
    "assertionHeaderName",
    "assertionHeaderOp",
    "assertionHeaderValue",
    "assertionStatusMin",
    "assertionStatusMax",
    "assertionJsonPath",
    "assertionJsonOp",
    "assertionJsonValue",
];
export const ASSERTION_FIELDS = CHECK_FIELDS.filter((f) => f.startsWith("assertion"));
export class DefinitionError extends Error {
    issues;
    constructor(issues) {
        super(issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
        this.name = "DefinitionError";
        this.issues = issues;
    }
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional -- mirrors api-schemas.ts's CONTROL_CHARACTERS_PATTERN to reject the same bytes.
const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const CONTROL_MESSAGE = "That text contains characters that aren't allowed. Remove any unusual symbols and try again.";
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Mirrors `noControlCharacters(z.string().trim().min(min).max(max))`. */
function checkString(issues, path, value, opts) {
    if (value === undefined && opts.required) {
        issues.push({ path, message: opts.required });
        return undefined;
    }
    if (typeof value !== "string") {
        issues.push({ path, message: "must be a string." });
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length < opts.min) {
        issues.push({ path, message: opts.required ?? `must be at least ${opts.min} characters.` });
        return undefined;
    }
    if (trimmed.length > opts.max) {
        issues.push({ path, message: `must be ${opts.max} characters or fewer.` });
        return undefined;
    }
    if (CONTROL_CHARACTERS_PATTERN.test(trimmed)) {
        issues.push({ path, message: CONTROL_MESSAGE });
        return undefined;
    }
    return trimmed;
}
function checkEnum(issues, path, value, allowed) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        issues.push({ path, message: `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}.` });
        return undefined;
    }
    return value;
}
function checkStatusCode(issues, path, value) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        issues.push({ path, message: "Status must be a whole number." });
        return undefined;
    }
    if (value < 100 || value > 599) {
        issues.push({ path, message: "Status must be between 100 and 599." });
        return undefined;
    }
    return value;
}
/**
 * The JSON-path grammar `assertionJsonPath` must satisfy -- a port of
 * packages/db/json-path.ts's acceptance rule (keys, `[n]` indices, quoted
 * keys, optional leading `$`, at most 32 segments; wildcards, filters, and
 * recursive descent refused). Accept/refuse only; the executor lives
 * server-side.
 */
export function isValidJsonPath(raw) {
    const input = raw.trim();
    if (!input || input.includes(".."))
        return false;
    let i = 0;
    if (input[i] === "$") {
        i++;
        if (i < input.length && input[i] !== "." && input[i] !== "[")
            return false;
        if (input[i] === ".")
            i++;
    }
    let segments = 0;
    while (i < input.length) {
        if (segments >= 32)
            return false;
        if (input[i] === "[") {
            const close = input.indexOf("]", i);
            if (close === -1)
                return false;
            const inner = input.slice(i + 1, close);
            if (inner === "*" || inner.startsWith("?") || inner === "")
                return false;
            const quoted = (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) || (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2);
            if (quoted) {
                if (inner.length === 2)
                    return false;
            }
            else if (!/^[0-9]+$/.test(inner))
                return false;
            segments++;
            i = close + 1;
            if (i < input.length) {
                if (input[i] === ".") {
                    i++;
                    if (i >= input.length)
                        return false;
                }
                else if (input[i] !== "[")
                    return false;
            }
            continue;
        }
        let end = i;
        while (end < input.length && input[end] !== "." && input[end] !== "[")
            end++;
        const key = input.slice(i, end);
        if (!key || key === "*" || key.includes("]"))
            return false;
        segments++;
        i = end;
        if (i < input.length && input[i] === ".") {
            i++;
            if (i >= input.length)
                return false;
        }
    }
    return segments > 0;
}
/** Per-field validation of one check -- a port of `checkCreateShape`. */
function validateCheckFields(raw, path, issues) {
    const before = issues.length;
    for (const key of Object.keys(raw)) {
        if (!CHECK_FIELDS.includes(key)) {
            issues.push({ path: `${path}.${key}`, message: `unknown field. POST /checks accepts: ${CHECK_FIELDS.join(", ")}.` });
        }
    }
    const out = {};
    const name = checkString(issues, `${path}.name`, raw.name, { min: 1, max: MAX_NAME_LENGTH, required: "Name is required." });
    if (name !== undefined)
        out.name = name;
    const url = checkString(issues, `${path}.url`, raw.url, { min: 1, max: Number.POSITIVE_INFINITY, required: "URL is required." });
    if (url !== undefined)
        out.url = url;
    if (raw.intervalSeconds !== undefined) {
        const v = raw.intervalSeconds;
        if (typeof v !== "number" || !Number.isFinite(v))
            issues.push({ path: `${path}.intervalSeconds`, message: "intervalSeconds must be a finite number." });
        else if (v < 1)
            issues.push({ path: `${path}.intervalSeconds`, message: "intervalSeconds must be a positive number." });
        else if (Math.round(v) < MIN_INTERVAL_SECONDS || Math.round(v) > MAX_INTERVAL_SECONDS) {
            issues.push({ path: `${path}.intervalSeconds`, message: `intervalSeconds must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.` });
        }
        else
            out.intervalSeconds = v;
    }
    if (raw.regions !== undefined) {
        const v = raw.regions;
        if (!Array.isArray(v))
            issues.push({ path: `${path}.regions`, message: "must be an array of regions." });
        else if (v.length === 0)
            issues.push({ path: `${path}.regions`, message: "Select at least one region." });
        else {
            const bad = v.find((r) => !LIVE_REGIONS.includes(r));
            if (bad !== undefined)
                issues.push({ path: `${path}.regions`, message: `unknown region ${JSON.stringify(bad)}; live regions are ${LIVE_REGIONS.join(", ")}.` });
            else if (new Set(v).size !== v.length)
                issues.push({ path: `${path}.regions`, message: "Select each region only once." });
            else
                out.regions = [...v];
        }
    }
    const str = (field, min, required) => {
        if (raw[field] === undefined)
            return;
        const v = checkString(issues, `${path}.${field}`, raw[field], { min, max: MAX_NAME_LENGTH, required });
        if (v !== undefined)
            out[field] = v;
    };
    if (raw.assertionBodyOp !== undefined) {
        const v = checkEnum(issues, `${path}.assertionBodyOp`, raw.assertionBodyOp, ["contains", "not_contains"]);
        if (v)
            out.assertionBodyOp = v;
    }
    str("assertionBodyValue", 1, "Enter the text to look for.");
    if (raw.assertionBodyCaseSensitive !== undefined) {
        if (typeof raw.assertionBodyCaseSensitive !== "boolean")
            issues.push({ path: `${path}.assertionBodyCaseSensitive`, message: "must be true or false." });
        else
            out.assertionBodyCaseSensitive = raw.assertionBodyCaseSensitive;
    }
    str("assertionHeaderName", 1, "Enter a header name.");
    if (raw.assertionHeaderOp !== undefined) {
        const v = checkEnum(issues, `${path}.assertionHeaderOp`, raw.assertionHeaderOp, ["equals", "contains"]);
        if (v)
            out.assertionHeaderOp = v;
    }
    str("assertionHeaderValue", 0);
    if (raw.assertionStatusMin !== undefined) {
        const v = checkStatusCode(issues, `${path}.assertionStatusMin`, raw.assertionStatusMin);
        if (v !== undefined)
            out.assertionStatusMin = v;
    }
    if (raw.assertionStatusMax !== undefined) {
        const v = checkStatusCode(issues, `${path}.assertionStatusMax`, raw.assertionStatusMax);
        if (v !== undefined)
            out.assertionStatusMax = v;
    }
    if (raw.assertionJsonPath !== undefined) {
        const v = checkString(issues, `${path}.assertionJsonPath`, raw.assertionJsonPath, { min: 1, max: MAX_NAME_LENGTH, required: "Enter a JSON path." });
        if (v !== undefined) {
            if (!isValidJsonPath(v))
                issues.push({ path: `${path}.assertionJsonPath`, message: "That JSON path is not valid. Use dots and brackets, for example data.items[0].status." });
            else
                out.assertionJsonPath = v;
        }
    }
    if (raw.assertionJsonOp !== undefined) {
        const v = checkEnum(issues, `${path}.assertionJsonOp`, raw.assertionJsonOp, ["equals", "contains", "exists"]);
        if (v)
            out.assertionJsonOp = v;
    }
    if (raw.assertionJsonValue !== undefined) {
        // No trim and no min: an empty value is a real thing to assert.
        const v = raw.assertionJsonValue;
        if (typeof v !== "string")
            issues.push({ path: `${path}.assertionJsonValue`, message: "must be a string." });
        else if (v.length > MAX_NAME_LENGTH)
            issues.push({ path: `${path}.assertionJsonValue`, message: `must be ${MAX_NAME_LENGTH} characters or fewer.` });
        else if (CONTROL_CHARACTERS_PATTERN.test(v))
            issues.push({ path: `${path}.assertionJsonValue`, message: CONTROL_MESSAGE });
        else
            out.assertionJsonValue = v;
    }
    if (issues.length > before)
        return undefined;
    const consistency = validateAssertionConsistency(out);
    if (consistency) {
        issues.push({ path, message: consistency });
        return undefined;
    }
    return out;
}
/** Cross-field rules -- a port of `validateHttpAssertionsShape`. Returns
 * the API's own message on failure, or null when consistent. */
export function validateAssertionConsistency(c) {
    const bodyPresent = c.assertionBodyOp !== undefined || c.assertionBodyValue !== undefined;
    if (bodyPresent && (c.assertionBodyOp === undefined || c.assertionBodyValue === undefined)) {
        return "A body assertion needs both a condition and text to look for.";
    }
    const headerPresent = c.assertionHeaderName !== undefined || c.assertionHeaderOp !== undefined || c.assertionHeaderValue !== undefined;
    if (headerPresent && (c.assertionHeaderName === undefined || c.assertionHeaderOp === undefined || c.assertionHeaderValue === undefined)) {
        return "A header assertion needs a header name, a condition, and a value.";
    }
    const statusPresent = c.assertionStatusMin !== undefined || c.assertionStatusMax !== undefined;
    if (statusPresent && (c.assertionStatusMin === undefined || c.assertionStatusMax === undefined)) {
        return "A status override needs both a minimum and a maximum status code.";
    }
    if (statusPresent && c.assertionStatusMax < c.assertionStatusMin) {
        return "The maximum status code must be at least the minimum.";
    }
    const jsonPresent = c.assertionJsonPath !== undefined || c.assertionJsonOp !== undefined || c.assertionJsonValue !== undefined;
    if (jsonPresent && (c.assertionJsonPath === undefined || c.assertionJsonOp === undefined)) {
        return "A JSON assertion needs both a path and a condition.";
    }
    if (c.assertionJsonOp === "exists" && c.assertionJsonValue !== undefined) {
        return '"exists" checks only that the path is there, so it takes no value.';
    }
    if ((c.assertionJsonOp === "equals" || c.assertionJsonOp === "contains") && c.assertionJsonValue === undefined) {
        return "A JSON equals or contains assertion needs a value to compare against.";
    }
    return null;
}
const TOP_LEVEL_KEYS = ["version", "checks"];
const STATUS_PAGES_NOT_IN_FILE = "status pages are not declared in a file; create one with `realuptime status-pages create`";
const COMPONENTS_NOT_IN_FILE = "components are not declared in a file; add one with `realuptime components add`";
const CHANNELS_NOT_IN_FILE = "notification channels are not declared in a file, because a channel's credential is write-only and could not be compared with the account; create one with `realuptime channels create`";
const NOT_IN_FILE = {
    status_pages: STATUS_PAGES_NOT_IN_FILE,
    statusPages: STATUS_PAGES_NOT_IN_FILE,
    components: COMPONENTS_NOT_IN_FILE,
    notification_channels: CHANNELS_NOT_IN_FILE,
    notificationChannels: CHANNELS_NOT_IN_FILE,
    alert_rules: "the REST API has no alert-rules endpoint yet",
    alertRules: "the REST API has no alert-rules endpoint yet",
};
/** Validates an already-parsed document (JSON or YAML) into a Definition,
 * or throws `DefinitionError` listing EVERY problem found, not just the
 * first, so a CI run fixes a file in one pass. */
export function validateDefinition(doc) {
    const issues = [];
    if (!isRecord(doc))
        throw new DefinitionError([{ path: "(root)", message: "the definition must be a mapping with `version` and `checks`." }]);
    for (const key of Object.keys(doc)) {
        if (TOP_LEVEL_KEYS.includes(key))
            continue;
        const why = NOT_IN_FILE[key];
        issues.push({
            path: key,
            message: why ? `not supported: ${why}. Remove it from the file.` : `unknown top-level key. Supported: ${TOP_LEVEL_KEYS.join(", ")}.`,
        });
    }
    if (doc.version !== DEFINITION_VERSION) {
        issues.push({ path: "version", message: `must be ${DEFINITION_VERSION} (got ${JSON.stringify(doc.version)}).` });
    }
    const checks = [];
    if (doc.checks === undefined) {
        issues.push({ path: "checks", message: "is required (use an empty list to declare no checks)." });
    }
    else if (!Array.isArray(doc.checks)) {
        issues.push({ path: "checks", message: "must be a list." });
    }
    else {
        const seen = new Map();
        doc.checks.forEach((raw, index) => {
            const path = `checks[${index}]`;
            if (!isRecord(raw)) {
                issues.push({ path, message: "must be a mapping." });
                return;
            }
            const check = validateCheckFields(raw, path, issues);
            // Duplicate-name detection runs even when the row has other problems,
            // so one pass reports every issue in the file.
            const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
            if (name) {
                const prior = seen.get(name);
                if (prior !== undefined) {
                    issues.push({ path: `${path}.name`, message: `duplicate name ${JSON.stringify(name)} (also checks[${prior}]); name is the key apply matches on, so it must be unique.` });
                    return;
                }
                seen.set(name, index);
            }
            if (check)
                checks.push(check);
        });
    }
    if (issues.length > 0)
        throw new DefinitionError(issues);
    return { version: DEFINITION_VERSION, checks };
}
export function formatForPath(path) {
    return /\.json$/i.test(path) ? "json" : "yaml";
}
/** Parses file text as JSON or the YAML subset (by extension, JSON first:
 * a `.yaml` file that happens to be valid JSON is accepted too). */
export function parseDefinitionText(text, format) {
    let doc;
    if (format === "json") {
        try {
            doc = JSON.parse(text);
        }
        catch (err) {
            throw new DefinitionError([{ path: "(file)", message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }]);
        }
    }
    else {
        try {
            doc = parseYaml(text);
        }
        catch (err) {
            if (err instanceof YamlError)
                throw new DefinitionError([{ path: "(file)", message: `invalid YAML: ${err.message}` }]);
            throw err;
        }
    }
    return validateDefinition(doc);
}
