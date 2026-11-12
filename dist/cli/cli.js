import { flagString, parseArgs } from "./args.js";
import { agentTokenCreate } from "./commands/agent.js";
import { channelsCreate, channelsList, channelsTest } from "./commands/channels.js";
import { checksCreate, checksDelete, checksList, checksRuns } from "./commands/checks.js";
import { errorsIssuesList, errorsIssuesSetStatus, errorsProjectsCreate, errorsProjectsList, errorsReleasesAnnounce, errorsSourcemapsUpload, } from "./commands/errors.js";
import { heartbeatsCreate, heartbeatsList } from "./commands/heartbeats.js";
import { incidentsCreate, incidentsList, incidentsUpdate } from "./commands/incidents.js";
import { maintenanceEnd, maintenanceStart, maintenanceStatus } from "./commands/maintenance.js";
import { applyCommand, exportCommand, validateCommand } from "./commands/mac.js";
import { outagesGet } from "./commands/outages.js";
import { componentsAdd, componentsList, statusPagesCreate, statusPagesGet, statusPagesList, } from "./commands/status-pages.js";
import { terraformExportCommand } from "./commands/terraform.js";
import { resolveConfig } from "./config.js";
import { CliError } from "./errors.js";
import { render, renderError, renderField } from "./output.js";
import { CLI_VERSION } from "./version.js";
export const USAGE = `realuptime -- a command-line client for the RealUptime REST API

Usage:
  realuptime checks list
  realuptime checks create --name <name> --url <url> [--interval <seconds>] [--regions iad,fra]
  realuptime checks delete <id>
  realuptime checks runs <id> [--limit <n>]   (a heartbeat monitor's runs)

  realuptime incidents list [--limit <n>]
  realuptime incidents create --status-page-id <id> --check-id <id> --region <region> --title <t> --body <b>
  realuptime incidents update <id> --status <investigating|identified|monitoring|resolved> --body <b> [--force]

  realuptime status-pages list
  realuptime status-pages create --name <name> [--slug <slug>]
  realuptime status-pages get <id>            (public_url is the page's address)

  realuptime components list --status-page-id <id>
  realuptime components add --status-page-id <id> --check-id <id> [--name <display name>] [--description <text>]

  realuptime channels list
  realuptime channels create --type <email|slack|discord|msteams|firehydrant|generic_json|opsgenie|incidentio>
                      [--name <name>] [--webhook-url <url>] [--url <url>] [--channel-api-key <key>]
                      [--region us|eu] [--alert-source-config-id <id>]
                      (email is the account owner's address and takes nothing else; slack is one
                       per account. --webhook-url defaults to REALUPTIME_ALERT_WEBHOOK_URL and
                       --channel-api-key to REALUPTIME_CHANNEL_API_KEY, so neither has to be typed)
  realuptime channels test <id>               (sends one real test alert; exit 1 if the destination refuses it)

  realuptime heartbeats list
  realuptime heartbeats create --name <name> [--interval <seconds>] [--grace <seconds>] [--status-page-id <id>]
                      (the ping URL is shown once, in this command's output, and never again)

  realuptime agent token create --name <server name>
                      (registers a server agent; its token is shown once, in this command's
                       output, and never again)

  realuptime maintenance start --status-page-id <id> --title <t> --body <b> (--duration-minutes <n> | --ends-at <iso>)
                      [--starts-at <iso>] [--component-ids <id1>,<id2>]
  realuptime maintenance end <id>
  realuptime maintenance status --status-page-id <id>

  realuptime apply -f realuptime.yaml [--dry-run] [--prune --yes] [--allow-replace]
  realuptime export [-f realuptime.yaml]
  realuptime validate -f realuptime.yaml
                      (monitoring-as-code: a YAML/JSON file of checks, diffed by name and
                       applied through the REST API; exit 2 = --dry-run found changes)

  realuptime terraform export [--dir <path>] [--force]
                      (writes .tf files for the realuptime Terraform provider from the
                       account's checks/status pages/components/channels, plus an
                       import.sh; --force writes into a non-empty --dir)

  realuptime outages <slug> [--region iad|sjc|fra|nrt]   (keyless, no API key needed)

  realuptime errors projects list
  realuptime errors projects create --name <name>
                      (the DSN is shown once, in this command's output, and never again)
  realuptime errors issues list --project-id <id> [--q <text>] [--release <r>] [--status <s>] [--window <w>] [--limit <n>]
  realuptime errors issues resolve <id>   (ignore <id> and reopen <id> work the same way; needs a read-write key)
  realuptime errors releases announce --project-id <id> --release <v> [--commit-sha <sha>] [--repo-url <url>] [--deployed-at <iso>] [--previous-release <v>]
  realuptime errors sourcemaps upload <dir-or-files...> --release <v> [--url-prefix <p>] [--dsn <dsn>] [--dry-run]
      (ingest-key authed: --dsn or REALUPTIME_ERRORS_DSN, or --ingest-key / REALUPTIME_ERRORS_INGEST_KEY; no API key needed)

Options:
  --api-key <key>   or the REALUPTIME_API_KEY environment variable
  --api-url <url>   or the REALUPTIME_API_URL environment variable (default https://realuptime.io/api/v1)
  --json            machine-readable output (the untouched API response)
  --field <path>    print one value of the response and nothing else, e.g. --field dsn,
                    --field token, --field pingUrl, --field statusPage.id. For capturing a
                    value that is shown once: VAR="$(realuptime ... --field token)"
  --version         print the CLI version and exit
`;
async function defaultFs() {
    const { readFile, writeFile } = await import("node:fs/promises");
    return {
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, text) => writeFile(path, text, "utf8"),
    };
}
async function defaultTerraformFs() {
    const { mkdir, readdir, writeFile } = await import("node:fs/promises");
    return {
        readdir: async (path) => {
            try {
                return await readdir(path);
            }
            catch (err) {
                if (err?.code === "ENOENT")
                    return [];
                throw err;
            }
        },
        mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
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
export async function runCli(argv, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const env = options.env ?? process.env;
    const stdout = options.stdout ?? ((line) => console.log(line));
    const stderr = options.stderr ?? ((line) => console.error(line));
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
            if (resource === "apply")
                return await applyCommand(ctx, flags);
            if (resource === "export")
                return await exportCommand(ctx, flags);
            return await validateCommand(ctx, flags);
        }
        if (resource === "terraform") {
            const [action] = rest;
            if (action !== "export")
                throw new CliError(`Unknown "terraform" subcommand "${action ?? ""}". Try: export.`);
            const ctx = { client, fs: options.terraformFs ?? (await defaultTerraformFs()), stdout };
            return await terraformExportCommand(ctx, flags);
        }
        let result;
        let testRefused = false;
        switch (resource) {
            case "checks": {
                const [action, id] = rest;
                if (action === "list")
                    result = await checksList(client);
                else if (action === "create")
                    result = await checksCreate(client, flags);
                else if (action === "delete")
                    result = await checksDelete(client, id);
                else if (action === "runs")
                    result = await checksRuns(client, id, flags);
                else
                    throw new CliError(`Unknown "checks" subcommand "${action ?? ""}". Try: list, create, delete, runs.`);
                break;
            }
            case "incidents": {
                const [action, id] = rest;
                if (action === "list")
                    result = await incidentsList(client, flags);
                else if (action === "create")
                    result = await incidentsCreate(client, flags);
                else if (action === "update")
                    result = await incidentsUpdate(client, id, flags);
                else
                    throw new CliError(`Unknown "incidents" subcommand "${action ?? ""}". Try: list, create, update.`);
                break;
            }
            case "status-pages": {
                const [action, id] = rest;
                if (action === "list")
                    result = await statusPagesList(client);
                else if (action === "create")
                    result = await statusPagesCreate(client, flags);
                else if (action === "get")
                    result = await statusPagesGet(client, id);
                else
                    throw new CliError(`Unknown "status-pages" subcommand "${action ?? ""}". Try: list, create, get.`);
                break;
            }
            case "components": {
                const [action] = rest;
                if (action === "list")
                    result = await componentsList(client, flags);
                else if (action === "add")
                    result = await componentsAdd(client, flags);
                else
                    throw new CliError(`Unknown "components" subcommand "${action ?? ""}". Try: list, add.`);
                break;
            }
            case "channels": {
                const [action, id] = rest;
                if (action === "list")
                    result = await channelsList(client);
                else if (action === "create")
                    result = await channelsCreate(client, flags, env);
                else if (action === "test") {
                    result = await channelsTest(client, id);
                    testRefused = result?.ok === false;
                }
                else
                    throw new CliError(`Unknown "channels" subcommand "${action ?? ""}". Try: list, create, test.`);
                break;
            }
            case "heartbeats": {
                const [action] = rest;
                if (action === "list")
                    result = await heartbeatsList(client);
                else if (action === "create")
                    result = await heartbeatsCreate(client, flags);
                else
                    throw new CliError(`Unknown "heartbeats" subcommand "${action ?? ""}". Try: list, create.`);
                break;
            }
            case "agent": {
                const [sub, action] = rest;
                if (sub === "token" && action === "create")
                    result = await agentTokenCreate(client, flags);
                else
                    throw new CliError(`Unknown "agent" subcommand "${[sub, action].filter(Boolean).join(" ")}". Try: token create.`);
                break;
            }
            case "maintenance": {
                const [action, id] = rest;
                if (action === "start")
                    result = await maintenanceStart(client, flags);
                else if (action === "end")
                    result = await maintenanceEnd(client, id);
                else if (action === "status")
                    result = await maintenanceStatus(client, flags);
                else
                    throw new CliError(`Unknown "maintenance" subcommand "${action ?? ""}". Try: start, end, status.`);
                break;
            }
            case "outages": {
                const [slug] = rest;
                result = await outagesGet(client, slug, flags);
                break;
            }
            case "errors": {
                const [sub, action, ...paths] = rest;
                if (sub === "projects" && action === "create")
                    result = await errorsProjectsCreate(client, flags);
                else if (sub === "projects" && action === "list")
                    result = await errorsProjectsList(client);
                else if (sub === "issues" && action === "list")
                    result = await errorsIssuesList(client, flags);
                else if (sub === "issues" && (action === "resolve" || action === "ignore" || action === "reopen"))
                    result = await errorsIssuesSetStatus(client, action, paths[0]);
                else if (sub === "releases" && action === "announce")
                    result = await errorsReleasesAnnounce(client, flags);
                else if (sub === "sourcemaps" && action === "upload")
                    result = await errorsSourcemapsUpload(client, paths, flags, env, stderr);
                else
                    throw new CliError(`Unknown "errors" subcommand "${[sub, action].filter(Boolean).join(" ")}". Try: projects list, projects create, issues list, issues resolve, issues ignore, issues reopen, releases announce, sourcemaps upload.`);
                break;
            }
            default:
                throw new CliError(`Unknown command "${resource}". Run "realuptime help" for usage.`);
        }
        // `--field` prints one value and nothing else, so a value that is shown
        // once can be captured by command substitution without reaching a
        // terminal or a log. Only ever stdout: stderr never carries a response.
        const field = flagString(flags, "field");
        stdout(field === undefined ? render(result, { json: config.json }) : renderField(result, field));
        if (testRefused) {
            stderr("The destination refused the test alert.");
            return 1;
        }
        return 0;
    }
    catch (err) {
        stderr(renderError(err));
        return 1;
    }
}
