import type { ParsedArgs } from "../args.ts";
import { flagBoolean, flagString } from "../args.ts";
import { CliError } from "../errors.ts";
import type { ClientConfig } from "../http.ts";
import { applyPlan, fetchChecks, renderApplyResult } from "../mac/apply.ts";
import { DefinitionError, formatForPath, parseDefinitionText } from "../mac/definition.ts";
import { buildExport, renderExport } from "../mac/export.ts";
import { buildPlan, planHasChanges, renderPlan } from "../mac/plan.ts";

/**
 * `realuptime apply` / `export` / `validate` -- monitoring-as-code (REA-246).
 * These three return an exit code AND their output directly (rather than a
 * result object for `render()`), because a plan is not an API response:
 * `--json` here means "the plan/result as JSON", not "the untouched API
 * body", and the exit code carries meaning (see `EXIT` below) the way CI
 * needs it to.
 */

/** Exit codes, chosen so a CI step can branch on them:
 *   0  success (applied, or nothing to do, or --dry-run with no changes)
 *   1  error (invalid file, API refusal, plan error, replace refused)
 *   2  --dry-run found pending changes (the "drift detected" signal) */
export const EXIT = { ok: 0, error: 1, changes: 2 } as const;

export interface FileSystemLike {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface MacContext {
  client: ClientConfig;
  fs: FileSystemLike;
  json: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function requireFile(flags: ParsedArgs["flags"], usage: string): string {
  const file = flagString(flags, "file");
  if (!file) throw new CliError(`--file (or -f) is required. Usage: ${usage}`);
  return file;
}

async function loadDefinition(ctx: MacContext, file: string) {
  let text: string;
  try {
    text = await ctx.fs.readFile(file);
  } catch (err) {
    throw new CliError(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseDefinitionText(text, formatForPath(file));
  } catch (err) {
    if (err instanceof DefinitionError) {
      throw new CliError(`${file} is not a valid definition:\n${err.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
    }
    throw err;
  }
}

export async function validateCommand(ctx: MacContext, flags: ParsedArgs["flags"]): Promise<number> {
  const file = requireFile(flags, "realuptime validate -f realuptime.yaml");
  const definition = await loadDefinition(ctx, file);
  ctx.stdout(ctx.json ? JSON.stringify({ valid: true, checks: definition.checks.length }, null, 2) : `${file}: valid (${definition.checks.length} check${definition.checks.length === 1 ? "" : "s"}).`);
  return EXIT.ok;
}

export async function applyCommand(ctx: MacContext, flags: ParsedArgs["flags"]): Promise<number> {
  const file = requireFile(flags, "realuptime apply -f realuptime.yaml [--dry-run] [--prune --yes] [--allow-replace]");
  const dryRun = flagBoolean(flags, "dry-run");
  const prune = flagBoolean(flags, "prune");
  const yes = flagBoolean(flags, "yes");
  const allowReplace = flagBoolean(flags, "allow-replace");

  const definition = await loadDefinition(ctx, file);
  const rows = await fetchChecks(ctx.client);
  const plan = buildPlan(definition, rows, { prune });

  if (plan.errors.length > 0) {
    ctx.stdout(ctx.json ? JSON.stringify({ plan, applied: null }, null, 2) : renderPlan(plan, { allowReplace }));
    ctx.stderr(`Cannot apply: ${plan.errors.length} problem${plan.errors.length === 1 ? "" : "s"} with the plan (see above).`);
    return EXIT.error;
  }

  if (dryRun) {
    ctx.stdout(ctx.json ? JSON.stringify({ plan, applied: null, dryRun: true }, null, 2) : `${renderPlan(plan, { allowReplace })}\n(dry run; nothing applied)`);
    return planHasChanges(plan) ? EXIT.changes : EXIT.ok;
  }

  if (!planHasChanges(plan)) {
    ctx.stdout(ctx.json ? JSON.stringify({ plan, applied: { steps: [], ok: true } }, null, 2) : `${renderPlan(plan, { allowReplace })}\nNothing to apply.`);
    return EXIT.ok;
  }

  if (plan.summary.delete > 0 && !yes) {
    ctx.stdout(ctx.json ? JSON.stringify({ plan, applied: null }, null, 2) : renderPlan(plan, { allowReplace }));
    ctx.stderr(`--prune would delete ${plan.summary.delete} check${plan.summary.delete === 1 ? "" : "s"}; re-run with --yes to confirm.`);
    return EXIT.error;
  }
  if (plan.summary.replace > 0 && !allowReplace) {
    ctx.stdout(ctx.json ? JSON.stringify({ plan, applied: null }, null, 2) : renderPlan(plan, { allowReplace }));
    ctx.stderr(`${plan.summary.replace} check${plan.summary.replace === 1 ? "" : "s"} would be deleted and recreated; re-run with --allow-replace to accept losing their history, or revert the url/intervalSeconds change.`);
    return EXIT.error;
  }

  const result = await applyPlan(ctx.client, plan, { allowReplace });
  if (ctx.json) ctx.stdout(JSON.stringify({ plan, applied: result }, null, 2));
  else ctx.stdout(`${renderPlan(plan, { allowReplace })}\n${renderApplyResult(result)}`);
  return result.ok ? EXIT.ok : EXIT.error;
}

export async function exportCommand(ctx: MacContext, flags: ParsedArgs["flags"]): Promise<number> {
  const file = flagString(flags, "file");
  const rows = await fetchChecks(ctx.client);
  const result = buildExport(rows);
  const format = file ? formatForPath(file) : ctx.json ? "json" : "yaml";
  const text = renderExport(result, format);
  if (file) {
    try {
      await ctx.fs.writeFile(file, text);
    } catch (err) {
      throw new CliError(`Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const skipped = result.skipped.length > 0 ? ` ${result.skipped.length} non-http check${result.skipped.length === 1 ? "" : "s"} not exported (see the file header).` : "";
    ctx.stdout(`Wrote ${result.definition.checks.length} check${result.definition.checks.length === 1 ? "" : "s"} to ${file}.${skipped}`);
  } else {
    ctx.stdout(text.trimEnd());
  }
  return EXIT.ok;
}
