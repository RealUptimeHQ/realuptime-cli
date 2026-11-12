import { ASSERTION_FIELDS, DEFAULT_CHECK_REGIONS, LIVE_REGIONS } from "./definition.js";
const ASSERTION_COLUMNS = {
    assertionBodyOp: "assertion_body_op",
    assertionBodyValue: "assertion_body_value",
    assertionBodyCaseSensitive: "assertion_body_case_sensitive",
    assertionHeaderName: "assertion_header_name",
    assertionHeaderOp: "assertion_header_op",
    assertionHeaderValue: "assertion_header_value",
    assertionStatusMin: "assertion_status_min",
    assertionStatusMax: "assertion_status_max",
    assertionJsonPath: "assertion_json_path",
    assertionJsonOp: "assertion_json_op",
    assertionJsonValue: "assertion_json_value",
};
/** The assertion fields of a definition, normalized the way the API stores
 * them: `assertionBodyCaseSensitive` defaults to true when a body assertion
 * is present (`validateHttpAssertionsShape`), and is absent otherwise. */
export function normalizedAssertions(def) {
    const out = {};
    for (const field of ASSERTION_FIELDS) {
        if (def[field] !== undefined)
            out[field] = def[field];
    }
    if (out.assertionBodyOp !== undefined && out.assertionBodyCaseSensitive === undefined)
        out.assertionBodyCaseSensitive = true;
    return out;
}
/** `GET /checks` row -> the definition-file shape of what's live. */
export function observedDefinition(row) {
    const def = {
        name: row.name,
        url: row.url ?? "",
        intervalSeconds: row.interval_seconds,
        regions: [...row.selected_regions],
    };
    if (row.latency_threshold_ms !== null && row.latency_threshold_ms !== undefined) {
        def.latencyThresholdMs = row.latency_threshold_ms;
    }
    for (const field of ASSERTION_FIELDS) {
        const value = row[ASSERTION_COLUMNS[field]];
        if (value !== null && value !== undefined)
            def[field] = value;
    }
    return def;
}
function sameRegionSet(a, b) {
    if (a.length !== b.length)
        return false;
    const set = new Set(a);
    return b.every((r) => set.has(r));
}
function sortRegions(regions) {
    return [...LIVE_REGIONS].filter((r) => regions.includes(r));
}
/** The desired regions: the file's, or every live region -- the API's own
 * default when `regions` is omitted at creation -- so omitting the key
 * means "all four", declaratively, not "leave whatever is there". */
export function desiredRegions(def) {
    return def.regions ? sortRegions(def.regions) : [...DEFAULT_CHECK_REGIONS];
}
export function diffCheck(desired, observed) {
    const changes = [];
    let needsReplace = false;
    if (desired.url !== observed.url) {
        changes.push({ field: "url", from: observed.url, to: desired.url });
        needsReplace = true;
    }
    if (desired.intervalSeconds !== undefined && desired.intervalSeconds !== observed.intervalSeconds) {
        changes.push({ field: "intervalSeconds", from: observed.intervalSeconds, to: desired.intervalSeconds });
        needsReplace = true;
    }
    const wantRegions = desiredRegions(desired);
    const haveRegions = observed.regions ?? [];
    const patchRegions = !sameRegionSet(wantRegions, haveRegions);
    if (patchRegions)
        changes.push({ field: "regions", from: sortRegions(haveRegions), to: wantRegions });
    // latencyThresholdMs edits in place via PATCH /checks/:id, like regions.
    // An undefined desired value means "leave as is", matching intervalSeconds'
    // declarative stance rather than treating omission as a clear.
    const patchLatency = desired.latencyThresholdMs !== undefined && desired.latencyThresholdMs !== observed.latencyThresholdMs;
    if (patchLatency) {
        changes.push({ field: "latencyThresholdMs", from: observed.latencyThresholdMs, to: desired.latencyThresholdMs });
    }
    const want = normalizedAssertions(desired);
    const have = normalizedAssertions(observed);
    let patchAssertions = false;
    for (const field of ASSERTION_FIELDS) {
        if (want[field] !== have[field]) {
            patchAssertions = true;
            changes.push({ field, from: have[field], to: want[field] });
        }
    }
    return { changes, patchRegions, patchLatency, patchAssertions, needsReplace };
}
export function buildPlan(definition, rows, options) {
    const actions = [];
    const notes = [];
    const errors = [];
    const byName = new Map();
    for (const row of rows) {
        const list = byName.get(row.name) ?? [];
        list.push(row);
        byName.set(row.name, list);
    }
    const claimed = new Set();
    for (const desired of definition.checks) {
        const matches = byName.get(desired.name) ?? [];
        if (matches.length > 1) {
            errors.push(`check "${desired.name}": ${matches.length} checks on the account share this name (${matches.map((m) => m.id).join(", ")}); rename or delete the extras in the dashboard so the file can match one.`);
            continue;
        }
        const match = matches[0];
        if (!match) {
            actions.push({ kind: "create", name: desired.name, desired });
            continue;
        }
        claimed.add(match.id);
        if (match.type !== "http") {
            errors.push(`check "${desired.name}": the account's check with this name is type "${match.type}", which the REST API can't create or edit; only http checks can be managed from a file. Rename one of them.`);
            continue;
        }
        const observed = observedDefinition(match);
        const diff = diffCheck(desired, observed);
        if (diff.changes.length === 0) {
            actions.push({ kind: "noop", name: desired.name, id: match.id });
        }
        else if (diff.needsReplace) {
            actions.push({ kind: "replace", name: desired.name, id: match.id, changes: diff.changes, desired });
        }
        else {
            actions.push({ kind: "update", name: desired.name, id: match.id, changes: diff.changes, patchRegions: diff.patchRegions, patchLatency: diff.patchLatency, patchAssertions: diff.patchAssertions, desired });
        }
    }
    for (const row of rows) {
        if (claimed.has(row.id))
            continue;
        if (row.type !== "http") {
            notes.push({ name: row.name, kind: "ignored", message: `type "${row.type}" is not manageable through the REST API; left alone.` });
            continue;
        }
        if (options.prune)
            actions.push({ kind: "delete", name: row.name, id: row.id });
        else
            notes.push({ name: row.name, kind: "unmanaged", message: "on the account but not in the file (pass --prune to delete it)." });
    }
    const summary = { create: 0, update: 0, replace: 0, delete: 0, noop: 0 };
    for (const action of actions)
        summary[action.kind]++;
    return { actions, notes, errors, summary };
}
export function planHasChanges(plan) {
    return plan.actions.some((a) => a.kind !== "noop");
}
function fmt(value) {
    if (value === undefined)
        return "(none)";
    if (Array.isArray(value))
        return `[${value.join(", ")}]`;
    return JSON.stringify(value);
}
/** The human plan. Stable prefixes (`+ ~ ! - =` and `?` for notes) so a
 * reader can scan it the way they'd scan a terraform plan. */
export function renderPlan(plan, opts) {
    const lines = [];
    const s = plan.summary;
    lines.push(`Plan: ${s.create} to create, ${s.update} to update, ${s.replace} to replace, ${s.delete} to delete, ${s.noop} unchanged.`);
    for (const action of plan.actions) {
        switch (action.kind) {
            case "create":
                lines.push(`  + check "${action.name}" (create)`);
                break;
            case "update":
                lines.push(`  ~ check "${action.name}" (update)`);
                for (const c of action.changes)
                    lines.push(`      ${c.field}: ${fmt(c.from)} -> ${fmt(c.to)}`);
                break;
            case "replace": {
                const why = action.changes
                    .filter((c) => c.field === "url" || c.field === "intervalSeconds")
                    .map((c) => c.field)
                    .join(", ");
                const how = opts.allowReplace ? "delete and recreate; history and id are lost" : "run with --allow-replace to delete and recreate it, losing its history and id";
                lines.push(`  ! check "${action.name}" (replace: ${why} changed and the API has no edit endpoint for it; ${how})`);
                for (const c of action.changes)
                    lines.push(`      ${c.field}: ${fmt(c.from)} -> ${fmt(c.to)}`);
                break;
            }
            case "delete":
                lines.push(`  - check "${action.name}" (delete, --prune)`);
                break;
            case "noop":
                lines.push(`  = check "${action.name}" (no changes)`);
                break;
        }
    }
    for (const note of plan.notes)
        lines.push(`  ? check "${note.name}": ${note.message}`);
    for (const error of plan.errors)
        lines.push(`  x ${error}`);
    return lines.join("\n");
}
