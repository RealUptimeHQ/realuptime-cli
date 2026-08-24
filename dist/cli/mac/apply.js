import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
import { ASSERTION_FIELDS } from "./definition.js";
import { desiredRegions } from "./plan.js";
export async function fetchChecks(client) {
    const response = await apiRequest(client, { path: "/checks" });
    if (!response || !Array.isArray(response.checks)) {
        throw new CliError("GET /checks returned an unexpected shape (no `checks` array).");
    }
    return response.checks;
}
/** The `POST /checks` body for a desired check: exactly its fields, nothing
 * defaulted client-side (the API applies its own defaults). */
export function createBody(desired) {
    const body = {};
    for (const [key, value] of Object.entries(desired))
        if (value !== undefined)
            body[key] = value;
    return body;
}
/** The `PATCH /checks/:id/assertions` body: the assertion fields only. An
 * empty object clears every assertion (the route is a full replace). */
export function assertionsBody(desired) {
    const body = {};
    for (const field of ASSERTION_FIELDS)
        if (desired[field] !== undefined)
            body[field] = desired[field];
    return body;
}
const ORDER = { delete: 0, replace: 1, create: 2, update: 3, noop: 4 };
export async function applyPlan(client, plan, opts) {
    const ordered = [...plan.actions].filter((a) => a.kind !== "noop").sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    const steps = [];
    let failed = false;
    for (const action of ordered) {
        if (failed) {
            steps.push({ action, status: "skipped" });
            continue;
        }
        try {
            await runAction(client, action, opts);
            steps.push({ action, status: "applied" });
        }
        catch (err) {
            failed = true;
            steps.push({ action, status: "failed", error: err instanceof CliError ? (err.code ? `${err.message} [${err.code}]` : err.message) : err instanceof Error ? err.message : String(err) });
        }
    }
    return { steps, ok: !failed };
}
async function runAction(client, action, opts) {
    switch (action.kind) {
        case "create":
            await apiRequest(client, { method: "POST", path: "/checks", body: createBody(action.desired) });
            return;
        case "update":
            if (action.patchRegions) {
                await apiRequest(client, { method: "PATCH", path: `/checks/${encodeURIComponent(action.id)}`, body: { regions: desiredRegions(action.desired) } });
            }
            if (action.patchAssertions) {
                await apiRequest(client, { method: "PATCH", path: `/checks/${encodeURIComponent(action.id)}/assertions`, body: assertionsBody(action.desired) });
            }
            return;
        case "replace":
            if (!opts.allowReplace) {
                throw new CliError(`check "${action.name}" needs to be deleted and recreated (url/intervalSeconds have no edit endpoint); re-run with --allow-replace to accept losing its history.`);
            }
            await apiRequest(client, { method: "DELETE", path: `/checks/${encodeURIComponent(action.id)}` });
            await apiRequest(client, { method: "POST", path: "/checks", body: createBody(action.desired) });
            return;
        case "delete":
            await apiRequest(client, { method: "DELETE", path: `/checks/${encodeURIComponent(action.id)}` });
            return;
        case "noop":
            return;
    }
}
export function renderApplyResult(result) {
    const lines = [];
    for (const step of result.steps) {
        const label = `${step.action.kind} check "${step.action.name}"`;
        if (step.status === "applied")
            lines.push(`  ok   ${label}`);
        else if (step.status === "failed")
            lines.push(`  FAIL ${label}: ${step.error}`);
        else
            lines.push(`  skip ${label} (stopped after the failure above)`);
    }
    const applied = result.steps.filter((s) => s.status === "applied").length;
    lines.push(result.ok ? `Applied ${applied} change${applied === 1 ? "" : "s"}.` : `Stopped: ${applied} applied, 1 failed, ${result.steps.length - applied - 1} skipped.`);
    return lines.join("\n");
}
