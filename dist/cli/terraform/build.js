import { dedupeIdentifiers, hclBool, hclNumber, hclRaw, hclString, hclStringList, hclVarRef, renderBlock, sanitizeIdentifier } from "./hcl.js";
const PROVIDER_CHANNEL_TYPES = new Set(["discord", "msteams", "opsgenie", "generic_json", "sms", "voice", "mobile_push"]);
/** Per-type `config` map keys the provider documents (resource_notification_channel.go's
 * `MarkdownDescription`). Empty for the reserved-but-undeliverable types: the schema
 * still requires a (possibly empty) map, so those export with `config = {}`. */
const CHANNEL_CONFIG_FIELDS = {
    discord: [{ key: "webhookUrl", sensitive: true, description: "Discord incoming webhook URL" }],
    msteams: [{ key: "webhookUrl", sensitive: true, description: "Microsoft Teams incoming webhook URL" }],
    generic_json: [{ key: "url", sensitive: true, description: "Generic JSON POST endpoint URL" }],
    opsgenie: [
        { key: "apiKey", sensitive: true, description: "Opsgenie API key" },
        { key: "region", sensitive: true, description: "Opsgenie region: us or eu" },
    ],
};
function camelToSnake(value) {
    return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
/** `realuptime_check` (http only, see module doc). */
export function buildChecks(rows) {
    const httpRows = rows.filter((row) => row.type === "http");
    const skipped = rows
        .filter((row) => row.type !== "http")
        .map((row) => ({ name: row.name, type: row.type, reason: "the provider's realuptime_check resource requires url, which non-http checks don't have" }));
    const addresses = dedupeIdentifiers(httpRows.map((row) => sanitizeIdentifier(row.name)));
    const checks = httpRows.map((row, index) => {
        const address = addresses[index];
        const mainGroup = [
            { key: "name", value: hclString(row.name) },
            { key: "url", value: row.url ? hclString(row.url) : undefined },
            { key: "interval_seconds", value: hclNumber(row.interval_seconds) },
            { key: "regions", value: hclStringList(row.selected_regions) },
        ];
        const assertionGroup = [];
        if (row.assertion_body_op) {
            assertionGroup.push({ key: "assertion_body_op", value: hclString(row.assertion_body_op) });
            assertionGroup.push({ key: "assertion_body_value", value: hclString(row.assertion_body_value ?? "") });
            if (row.assertion_body_case_sensitive !== null) {
                assertionGroup.push({ key: "assertion_body_case_sensitive", value: hclBool(row.assertion_body_case_sensitive) });
            }
        }
        if (row.assertion_header_op) {
            assertionGroup.push({ key: "assertion_header_name", value: hclString(row.assertion_header_name ?? "") });
            assertionGroup.push({ key: "assertion_header_op", value: hclString(row.assertion_header_op) });
            assertionGroup.push({ key: "assertion_header_value", value: hclString(row.assertion_header_value ?? "") });
        }
        if (row.assertion_status_min !== null) {
            assertionGroup.push({ key: "assertion_status_min", value: hclNumber(row.assertion_status_min) });
            if (row.assertion_status_max !== null)
                assertionGroup.push({ key: "assertion_status_max", value: hclNumber(row.assertion_status_max) });
        }
        if (row.assertion_json_op) {
            assertionGroup.push({ key: "assertion_json_path", value: hclString(row.assertion_json_path ?? "") });
            assertionGroup.push({ key: "assertion_json_op", value: hclString(row.assertion_json_op) });
            if (row.assertion_json_value !== null)
                assertionGroup.push({ key: "assertion_json_value", value: hclString(row.assertion_json_value) });
        }
        const block = renderBlock(`resource "realuptime_check" "${address}"`, [mainGroup, assertionGroup]);
        return { address, id: row.id, block, importId: row.id };
    });
    return { checks, skipped };
}
/** `realuptime_status_page`. Every account's page is representable (no
 * schema constraint excludes any of them), so nothing is ever skipped here. */
export function buildStatusPages(rows) {
    const addresses = dedupeIdentifiers(rows.map((row) => sanitizeIdentifier(row.name)));
    return rows.map((row, index) => {
        const address = addresses[index];
        const group = [
            { key: "name", value: hclString(row.name) },
            { key: "slug", value: hclString(row.slug) },
            { key: "page_title", value: row.page_title ? hclString(row.page_title) : undefined },
            { key: "page_description", value: row.page_description ? hclString(row.page_description) : undefined },
            { key: "logo_url", value: row.logo_url ? hclString(row.logo_url) : undefined },
            { key: "hide_branding", value: row.hide_branding ? hclBool(true) : undefined },
            { key: "accent_color", value: row.accent_color ? hclString(row.accent_color) : undefined },
            { key: "homepage_url", value: row.homepage_url ? hclString(row.homepage_url) : undefined },
            { key: "support_url", value: row.support_url ? hclString(row.support_url) : undefined },
            { key: "theme_preset", value: row.theme_preset ? hclString(row.theme_preset) : undefined },
            { key: "font_choice", value: row.font_choice ? hclString(row.font_choice) : undefined },
            { key: "locale", value: row.locale ? hclString(row.locale) : undefined },
        ];
        const block = renderBlock(`resource "realuptime_status_page" "${address}"`, [group]);
        return { address, id: row.id, block, importId: row.id };
    });
}
/** `realuptime_status_page_component`. `status_page_id`/`check_id` reference
 * the matching exported resource by address when it was exported (every
 * status page always is; a check only when it's `http`), and fall back to
 * the literal id otherwise -- e.g. a component publishing a `tcp` check,
 * which `buildChecks` skipped, still needs a valid `check_id`. */
export function buildComponents(rows, statusPageAddressById, checkAddressById) {
    const addresses = dedupeIdentifiers(rows.map((row) => sanitizeIdentifier(row.display_name)));
    return rows.map((row, index) => {
        const address = addresses[index];
        const pageAddress = statusPageAddressById.get(row.status_page_id);
        const checkAddress = checkAddressById.get(row.check_id);
        const group = [
            { key: "status_page_id", value: pageAddress ? hclRaw(`realuptime_status_page.${pageAddress}.id`) : hclString(row.status_page_id) },
            { key: "check_id", value: checkAddress ? hclRaw(`realuptime_check.${checkAddress}.id`) : hclString(row.check_id) },
            { key: "display_name", value: hclString(row.display_name) },
            { key: "description", value: row.description ? hclString(row.description) : undefined },
        ];
        const block = renderBlock(`resource "realuptime_status_page_component" "${address}"`, [group]);
        return { address, id: row.id, block, importId: `${row.status_page_id}/${row.id}` };
    });
}
/** `realuptime_notification_channel`. The API never returns a channel's
 * credential (write-only by design), so every config field becomes a
 * `variable` reference instead of a literal -- the exported `.tf` never
 * embeds a webhook URL or API key, matching REA-533's secrets rule. */
export function buildChannels(rows) {
    const supportedRows = rows.filter((row) => PROVIDER_CHANNEL_TYPES.has(row.type));
    const skipped = rows
        .filter((row) => !PROVIDER_CHANNEL_TYPES.has(row.type))
        .map((row) => ({ name: row.name, type: row.type, reason: "the provider's realuptime_notification_channel resource has no type for it" }));
    const addresses = dedupeIdentifiers(supportedRows.map((row) => sanitizeIdentifier(row.name)));
    const variables = [];
    const channels = supportedRows.map((row, index) => {
        const address = addresses[index];
        const fields = CHANNEL_CONFIG_FIELDS[row.type] ?? [];
        const configLines = fields.map((field) => {
            const varName = `${address}_${camelToSnake(field.key)}`;
            variables.push({ name: varName, sensitive: field.sensitive, description: `${field.description} (channel "${row.name}", currently: ${row.config_summary})` });
            return `    ${field.key} = ${hclVarRef(varName)}`;
        });
        const configValue = configLines.length > 0 ? `{\n${configLines.join("\n")}\n  }` : "{}";
        const group = [
            { key: "type", value: hclString(row.type) },
            { key: "name", value: hclString(row.name) },
            { key: "config", value: configValue },
        ];
        const enabledGroup = row.disabled_at !== null ? [{ key: "enabled", value: hclBool(false) }] : [];
        const block = renderBlock(`resource "realuptime_notification_channel" "${address}"`, [group, enabledGroup]);
        return { address, id: row.id, block, importId: row.id };
    });
    return { channels, variables, skipped };
}
