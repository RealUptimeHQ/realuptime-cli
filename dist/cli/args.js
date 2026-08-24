import { CliError } from "./errors.js";
/**
 * Zero-dependency argv parser (REA-180: the CLI takes minimal, pinned deps
 * only if truly needed, and this doesn't need one). Deliberately small:
 * every realuptime command takes only long `--flag` options (no short
 * flags, no `--` separator, no repeated-flag arrays), so this covers the
 * whole surface without pulling in yargs/commander/minimist.
 *
 * `--flag value` and `--flag=value` are equivalent. A `--flag` immediately
 * followed by another `--flag` (or by nothing) is a boolean `true` --
 * this is what lets `--force`/`--json` work with no value, and is also why
 * a flag's VALUE must never itself start with `--` (none of this CLI's
 * flag values do: ids, urls without a literal `--` in them, enums, numbers).
 */
export function parseArgs(argv) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf("=");
        if (eq !== -1) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            flags[body] = next;
            i++;
        }
        else {
            flags[body] = true;
        }
    }
    return { positionals, flags };
}
/** A flag's string value, or `undefined` if it was never passed. Throws if
 * the flag was passed as a bare boolean (`--name` with no value) where a
 * value was expected, so a typo'd command fails with a clear message rather
 * than silently sending `"true"` to the API. */
export function flagString(flags, name) {
    const value = flags[name];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string") {
        throw new CliError(`--${name} needs a value.`);
    }
    return value;
}
export function requireFlagString(flags, name) {
    const value = flagString(flags, name);
    if (value === undefined) {
        throw new CliError(`--${name} is required.`);
    }
    return value;
}
export function flagBoolean(flags, name) {
    const value = flags[name];
    return value === true || value === "true";
}
export function flagNumber(flags, name) {
    const raw = flagString(flags, name);
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new CliError(`--${name} must be a number.`);
    }
    return value;
}
/** `--regions iad,fra` -> `["iad", "fra"]`. Trims whitespace and drops empty
 * segments (a stray trailing comma), never silently drops a real value. */
export function flagList(flags, name) {
    const raw = flagString(flags, name);
    if (raw === undefined)
        return undefined;
    return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
