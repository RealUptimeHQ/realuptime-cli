import { DEFINITION_VERSION } from "./definition.js";
import { observedDefinition } from "./plan.js";
import { stringifyYaml } from "./yaml.js";
export function buildExport(rows) {
    const checks = [];
    const skipped = [];
    for (const row of rows) {
        if (row.type !== "http") {
            skipped.push({ name: row.name, type: row.type });
            continue;
        }
        checks.push(observedDefinition(row));
    }
    return { definition: { version: DEFINITION_VERSION, checks }, skipped };
}
export function renderExport(result, format) {
    const doc = { version: result.definition.version, checks: result.definition.checks };
    if (format === "json")
        return `${JSON.stringify(doc, null, 2)}\n`;
    const header = [
        "# realuptime monitoring-as-code definition (exported by `realuptime export`).",
        "# Apply with: realuptime apply -f <this file> [--dry-run] [--prune --yes]",
    ];
    if (result.skipped.length > 0) {
        header.push(`# Not exported (the REST API can't create these types): ${result.skipped.map((s) => `${JSON.stringify(s.name)} (${s.type})`).join(", ")}`);
    }
    return `${header.join("\n")}\n${stringifyYaml(doc)}\n`;
}
