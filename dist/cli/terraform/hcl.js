/**
 * Minimal HCL (Terraform config language) text builder for `realuptime
 * terraform export` (REA-533). No parser, no dependency on the real
 * `terraform fmt` binary: this covers exactly the shapes the exporter
 * needs -- provider/resource/variable blocks with a flat list of
 * attributes, each attribute a string, number, boolean, string list, or a
 * raw expression (a resource reference, or `var.x`).
 */
/** `"..."`, escaping backslashes, double quotes, and the two HCL
 * interpolation openers (`${`/`%{`) so a value that happens to contain them
 * (a check name, a status page description) round-trips as a literal
 * string rather than being parsed as an expression. */
export function hclString(value) {
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\$\{/g, "$$$${")
        .replace(/%\{/g, "%%{")
        .replace(/\n/g, "\\n");
    return `"${escaped}"`;
}
export function hclNumber(value) {
    return String(value);
}
export function hclBool(value) {
    return value ? "true" : "false";
}
export function hclStringList(values) {
    return `[${values.map(hclString).join(", ")}]`;
}
/** A raw, unquoted expression: a resource attribute reference
 * (`realuptime_status_page.public.id`) or a variable reference
 * (`var.discord_webhook_url`). Passed through verbatim. */
export function hclRaw(expr) {
    return expr;
}
export function hclVarRef(name) {
    return `var.${name}`;
}
/**
 * Renders one `resource`/`data`/`provider` block. `attrGroups` is a list of
 * attribute groups, each rendered with its own `=` alignment and separated
 * by a blank line -- matching `terraform fmt`'s per-group alignment, and
 * the style already used in `packages/terraform-provider-realuptime`'s own
 * `examples/**\/*.tf`. `undefined` values are dropped before alignment is
 * computed, so an all-skipped group renders nothing (and is itself skipped
 * if it leaves no attributes and no leading comment).
 */
export function renderBlock(header, attrGroups, opts = {}) {
    const lines = [];
    if (opts.leadingComment) {
        for (const commentLine of opts.leadingComment.split("\n"))
            lines.push(`# ${commentLine}`.trimEnd());
    }
    lines.push(`${header} {`);
    const renderedGroups = attrGroups.map((group) => group.filter((attr) => attr.value !== undefined));
    const nonEmptyGroups = renderedGroups.filter((group) => group.length > 0);
    nonEmptyGroups.forEach((group, index) => {
        const width = Math.max(...group.map((attr) => attr.key.length));
        for (const attr of group) {
            lines.push(`  ${attr.key.padEnd(width)} = ${attr.value}`);
        }
        if (index < nonEmptyGroups.length - 1)
            lines.push("");
    });
    lines.push("}");
    return lines.join("\n");
}
/** `variable "name" { type = string; sensitive = true }` -- always used for
 * a notification channel's write-only config, per REA-533's rule that no
 * secret is ever embedded directly in a generated `.tf` file. */
export function renderVariableBlock(name, opts = {}) {
    const lines = [`variable ${hclString(name)} {`, "  type = string"];
    if (opts.description)
        lines.push(`  description = ${hclString(opts.description)}`);
    if (opts.sensitive)
        lines.push("  sensitive = true");
    lines.push("}");
    return lines.join("\n");
}
/**
 * Turns free text into a valid Terraform identifier: lowercase, non
 * `[a-z0-9_]` runs collapsed to a single `_`, leading/trailing `_` trimmed,
 * and a leading digit (identifiers can't start with one) prefixed with `_`.
 * An input that sanitizes to nothing falls back to `resource` rather than
 * producing an empty or duplicate-looking block label.
 */
export function sanitizeIdentifier(input) {
    let s = input
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (s === "")
        s = "resource";
    if (/^[0-9]/.test(s))
        s = `_${s}`;
    return s;
}
/**
 * Deterministically dedupes a list of already-sanitized identifiers by
 * appending `_2`, `_3`, ... to each repeat, in encounter order (the order
 * the API returned the rows in, which is itself deterministic -- oldest
 * first for checks/status pages). Never reorders or drops an entry.
 */
export function dedupeIdentifiers(names) {
    const seen = new Map();
    return names.map((name) => {
        const count = (seen.get(name) ?? 0) + 1;
        seen.set(name, count);
        return count === 1 ? name : `${name}_${count}`;
    });
}
