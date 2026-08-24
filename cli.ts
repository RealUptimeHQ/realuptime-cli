import { parseArgs } from "./args.ts";
import { checksCreate, checksDelete, checksList } from "./commands/checks.ts";
import { errorsIssuesList, errorsReleasesAnnounce, errorsSourcemapsUpload } from "./commands/errors.ts";
import { incidentsCreate, incidentsList, incidentsUpdate } from "./commands/incidents.ts";
import { applyCommand, exportCommand, type FileSystemLike, validateCommand } from "./commands/mac.ts";
import { outagesGet } from "./commands/outages.ts";
import { statusPagesList } from "./commands/status-pages.ts";
import { resolveConfig } from "./config.ts";
import { CliError } from "./errors.ts";
import type { FetchLike } from "./http.ts";
import { render, renderError } from "./output.ts";
import { CLI_VERSION } from "./version.ts";

export const USAGE = `realuptime -- a command-line client for the RealUptime REST API

Usage:
  realuptime checks list
  realuptime checks create --name <name> --url <url> [--interval <seconds>] [--regions iad,fra]
  realuptime checks delete <id>

  realuptime incidents list [--limit <n>]
  realuptime incidents create --status-page-id <id> --check-id <id> --region <region> --title <t> --body <b>
  realuptime incidents update <id> --status <investigating|identified|monitoring|resolved> --body <b> [--force]

  realuptime status-pages list

  realuptime apply -f realuptime.yaml [--dry-run] [--prune --yes] [--allow-replace]
  realuptime export [-f realuptime.yaml]
  realuptime validate -f realuptime.yaml
                      (monitoring-as-code: a YAML/JSON file of checks, diffed by name and
                       applied through the REST API; exit 2 = --dry-run found changes)

  realuptime outages <slug> [--region iad|sjc|fra|nrt]   (keyless, no API key needed)

  realuptime errors issues list --project-id <id> [--q <text>] [--release <r>] [--status <s>] [--window <w>] [--limit <n>]
  realuptime errors releases announce --project-id <id> --release <v> [--commit-sha <sha>] [--repo-url <url>] [--deployed-at <iso>] [--previous-release <v>]
  realuptime errors sourcemaps upload <dir-or-files...> --release <v> [--url-prefix <p>] [--dsn <dsn>] [--dry-run]
      (ingest-key authed: --dsn or REALUPTIME_ERRORS_DSN, or --ingest-key / REALUPTIME_ERRORS_INGEST_KEY; no API key needed)

Options:
  --api-key <key>   or the REALUPTIME_API_KEY environment variable
  --api-url <url>   or the REALUPTIME_API_URL environment variable (default https://realuptime.io/api/v1)
  --json            machine-readable output (the untouched API response)
  --version         print the CLI version and exit
`;

export interface RunCliOptions {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** File access for `apply`/`export`/`validate`; injectable so tests run
   * against an in-memory map instead of the real disk. */
  fs?: FileSystemLike;
}

async function defaultFs(): Promise<FileSystemLike> {
  const { readFile, writeFile } = await import("node:fs/promises");
  return {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, text) => writeFile(path, text, "utf8"),
  };
}

/**
 * The CLI's single entry point (REA-180), also the thing every test in
 * `./cli.test.ts` drives directly: `fetchImpl`/`env`/`stdout`/`stderr` are
 * all injectable so a test can run a full command round-trip against a
 * stub transport with no network, no real environment, and no captured
 * console output.
 *
 * Returns a process exit code rather than calling `process.exit` itself --
 * `bin/realuptime.ts` is the only place that actually exits the process.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  // `-f` is the one short flag this CLI takes (apply/export/validate's file,
  // the spelling every comparable tool uses); normalized here so the
  // long-only parser never has to know about it.
  const { positionals, flags } = parseArgs(argv.map((token) => (token === "-f" ? "--file" : token)));
  const [resource, ...rest] = positionals;

  if (flags.version === true || resource === "version") {
    stdout(CLI_VERSION);
    return 0;
  }

  if (!resource || resource === "help" || flags.help === true) {
    stdout(USAGE.trimEnd());
    return resource ? 0 : 1;
  }

  const config = resolveConfig(flags, env);
  const client = { apiUrl: config.apiUrl, apiKey: config.apiKey, fetchImpl };

  try {
    if (resource === "apply" || resource === "export" || resource === "validate") {
      const ctx = { client, fs: options.fs ?? (await defaultFs()), json: config.json, stdout, stderr };
      if (resource === "apply") return await applyCommand(ctx, flags);
      if (resource === "export") return await exportCommand(ctx, flags);
      return await validateCommand(ctx, flags);
    }

    let result: unknown;

    switch (resource) {
      case "checks": {
        const [action, id] = rest;
        if (action === "list") result = await checksList(client);
        else if (action === "create") result = await checksCreate(client, flags);
        else if (action === "delete") result = await checksDelete(client, id);
        else throw new CliError(`Unknown "checks" subcommand "${action ?? ""}". Try: list, create, delete.`);
        break;
      }
      case "incidents": {
        const [action, id] = rest;
        if (action === "list") result = await incidentsList(client, flags);
        else if (action === "create") result = await incidentsCreate(client, flags);
        else if (action === "update") result = await incidentsUpdate(client, id, flags);
        else throw new CliError(`Unknown "incidents" subcommand "${action ?? ""}". Try: list, create, update.`);
        break;
      }
      case "status-pages": {
        const [action] = rest;
        if (action === "list") result = await statusPagesList(client);
        else throw new CliError(`Unknown "status-pages" subcommand "${action ?? ""}". Try: list.`);
        break;
      }
      case "outages": {
        const [slug] = rest;
        result = await outagesGet(client, slug, flags);
        break;
      }
      case "errors": {
        const [sub, action, ...paths] = rest;
        if (sub === "issues" && action === "list") result = await errorsIssuesList(client, flags);
        else if (sub === "releases" && action === "announce") result = await errorsReleasesAnnounce(client, flags);
        else if (sub === "sourcemaps" && action === "upload")
          result = await errorsSourcemapsUpload(client, paths, flags, env, stderr);
        else
          throw new CliError(
            `Unknown "errors" subcommand "${[sub, action].filter(Boolean).join(" ")}". Try: issues list, releases announce, sourcemaps upload.`,
          );
        break;
      }
      default:
        throw new CliError(`Unknown command "${resource}". Run "realuptime help" for usage.`);
    }

    stdout(render(result, { json: config.json }));
    return 0;
  } catch (err) {
    stderr(renderError(err));
    return 1;
  }
}
